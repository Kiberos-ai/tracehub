import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";

// =============================================================================
// Integration test harness
//
// Each test file boots a real server as a subprocess against its own database
// and port. That is deliberate: configuration is read from the environment at
// module load, so in-process imports would freeze one config for the whole run
// and could not cover the adaptive timers or the startup reclaim at all.
// =============================================================================

export interface TestServer {
	url: string;
	dbPath: string;
	/** Everything the process wrote to stderr, including the startup banner. */
	stderr(): string;
	stop(): Promise<void>;
}

/**
 * Boot a server and wait until /health answers.
 * `env` overrides defaults, so a test can shorten adaptive TTLs or set a secret.
 */
export async function startServer(
	name: string,
	port: number,
	env: Record<string, string> = {},
	opts: { keepDb?: boolean } = {},
): Promise<TestServer> {
	const dbPath = `./data/test-${name}.db`;
	if (!opts.keepDb) cleanupDb(dbPath);

	const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
		env: {
			...process.env,
			TRACEHUB_PORT: String(port),
			TRACEHUB_DB: dbPath,
			// Never let a test reach the real context777 central.
			TRACEHUB_DOCS_CENTRAL_URL: "",
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	let stderrText = "";
	const drain = (async () => {
		for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
			stderrText += new TextDecoder().decode(chunk);
		}
	})();

	const url = `http://localhost:${port}`;
	try {
		await waitForHealth(url, proc, () => stderrText);
	} catch (e) {
		// A failed boot must not leave the process holding the port: afterAll never
		// runs when beforeAll throws, and the next run would fail for the wrong reason.
		proc.kill();
		await proc.exited.catch(() => {});
		throw e;
	}

	return {
		url,
		dbPath,
		stderr: () => stderrText,
		async stop() {
			proc.kill();
			await proc.exited;
			await drain.catch(() => {});
			cleanupDb(dbPath);
		},
	};
}

async function waitForHealth(
	url: string,
	proc: Bun.Subprocess,
	stderr: () => string,
): Promise<void> {
	// Under bun's 5s default hook timeout, anything longer means the hook is killed
	// before the diagnostic below can be thrown. The server starts in ~300ms.
	const deadline = Date.now() + 3_500;
	let lastStatus = 0;

	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			throw new Error(`server exited early (code ${proc.exitCode})\n${stderr()}`);
		}
		try {
			const res = await fetch(`${url}/health`);
			if (res.ok) return;
			lastStatus = res.status;
		} catch {
			// not listening yet
		}
		await Bun.sleep(100);
	}

	// Distinguish "never came up" from "came up but refuses /health" — the latter
	// is what a globally mounted auth middleware looks like, and saying so beats
	// leaving a future reader with an unnamed beforeAll failure.
	const detail =
		lastStatus === 401 || lastStatus === 403
			? `/health answered ${lastStatus}: auth is no longer scoped to /ingest`
			: lastStatus > 0
				? `/health answered ${lastStatus}`
				: "nothing ever listened on the port";

	throw new Error(`server at ${url} never became healthy — ${detail}\n${stderr()}`);
}

/** Remove a test database and its WAL sidecars. */
export function cleanupDb(dbPath: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		rmSync(`${dbPath}${suffix}`, { force: true });
	}
}

/** A valid trace body; override any field per test. */
export function trace(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		source_id: "TS",
		correlation_id: "corr-1",
		timestamp: 1_700_000_000_000,
		suffix: "aaa",
		direction: "->",
		operation: "REST",
		endpoint: "/api/test",
		...over,
	};
}

export async function postJson(
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

// biome-ignore lint/suspicious/noExplicitAny: test helper reads ad-hoc response shapes
export async function getJson<T = any>(url: string): Promise<T> {
	const res = await fetch(url);
	return (await res.json()) as T;
}

/**
 * Build a database that is bloated exactly the way production was: rows written
 * then deleted, with the freed pages still occupying the file.
 */
export function makeBloatedDb(dbPath: string, rows = 8000): number {
	cleanupDb(dbPath);
	const d = new Database(dbPath);
	d.exec("PRAGMA journal_mode = WAL");
	d.exec(`CREATE TABLE traces (
		id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL,
		correlation_id TEXT NOT NULL, timestamp REAL NOT NULL, suffix TEXT NOT NULL,
		direction TEXT NOT NULL, operation TEXT NOT NULL, endpoint TEXT NOT NULL,
		data TEXT, hostname TEXT, raw_line TEXT,
		created_at REAL DEFAULT (strftime('%s','now')),
		UNIQUE(correlation_id, timestamp, suffix))`);
	const ins = d.prepare(
		"INSERT INTO traces (source_id,correlation_id,timestamp,suffix,direction,operation,endpoint,data,created_at) VALUES (?,?,?,?,?,?,?,?,1)",
	);
	const filler = "x".repeat(3000);
	d.exec("BEGIN");
	for (let i = 0; i < rows; i++) {
		ins.run("S", `c${i}`, i, `s${i}`, "->", "OP", "/e", filler);
	}
	d.exec("COMMIT");
	d.exec("DELETE FROM traces");
	d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	d.close();
	return Bun.file(dbPath).size;
}

/**
 * Read an SSE stream until `needle` appears, or give up after `timeoutMs`.
 * Returns everything read, so a failing assertion shows what did arrive.
 */
export async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	needle: string,
	timeoutMs = 8000,
): Promise<string> {
	const decoder = new TextDecoder();
	const deadline = Date.now() + timeoutMs;
	let seen = "";

	while (Date.now() < deadline && !seen.includes(needle)) {
		const chunk = await Promise.race([
			reader.read(),
			Bun.sleep(deadline - Date.now()).then(() => null),
		]);
		if (!chunk || chunk.done) break;
		seen += decoder.decode(chunk.value ?? new Uint8Array());
	}
	return seen;
}

/** Size of the main database file in bytes. */
export function dbSize(dbPath: string): number {
	return Bun.file(dbPath).size;
}
