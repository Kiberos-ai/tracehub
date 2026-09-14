import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { type TestServer, postJson, startServer, trace } from "./helpers";

// Under WAL, a trace is durable the moment it is written but it is NOT in the
// database file — it sits in the -wal file until a checkpoint folds it back.
// Measured on this code before the fix: 1000 ingested traces, live queries all
// correct, main file 4096 bytes, WAL 3.8 MB, and a plain copy of the main file
// contained no traces table at all. That copy opened without complaint and
// answered every question with silence, which is the worst possible failure for
// a service people copy precisely when an incident is already underway.
//
// Two doors are guarded here: the hourly cleanup folds the log back even when it
// deletes nothing, and src/tools/snapshot.ts writes a complete file on demand
// without stopping the service.

const PORT = 19133;
const INGESTED = 300;

let server: TestServer;
let snapshotPath: string;

/** Remove a database file together with the sidecars a reader leaves beside it. */
function removeDb(path: string): void {
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

function rowsIn(path: string): number | null {
	if (!existsSync(path)) return null;
	const db = new Database(path, { readonly: true });
	try {
		return (db.query("SELECT count(*) AS c FROM traces").get() as { c: number }).c;
	} catch {
		// No traces table at all — everything is still in the log.
		return null;
	} finally {
		db.close();
	}
}

beforeAll(async () => {
	server = await startServer("wal-snapshot", PORT);
	snapshotPath = `${server.dbPath}.snapshot`;
	removeDb(snapshotPath);

	const traces = Array.from({ length: INGESTED }, (_, i) =>
		trace({
			correlation_id: `wal-${i}`,
			endpoint: `/api/wal/${i}`,
			data: { filler: "x".repeat(200) },
		}),
	);
	const res = await postJson(`${server.url}/ingest`, { traces });
	expect(res.status).toBe(200);
});

afterAll(async () => {
	removeDb(snapshotPath);
	await server.stop();
});

describe("the database file a person copies", () => {
	test("without a fold, a plain copy is missing traces the service already holds", () => {
		// The negative control. If this ever stops holding, the two tests below
		// prove nothing — they would pass against a service that never folds at
		// all. Failing here means the premise changed (a smaller autocheckpoint
		// threshold, a different journal mode), not that the fix regressed.
		const bare = `${server.dbPath}.bare`;
		removeDb(bare);
		copyFileSync(server.dbPath, bare);
		const copied = rowsIn(bare);
		removeDb(bare);

		expect(copied === null || copied < INGESTED).toBe(true);
	});

	test("after a cleanup that deletes nothing, a plain copy carries every trace", async () => {
		// Retention is 24h and these traces are seconds old, so this cleanup
		// deletes zero rows — which is exactly the case that used to skip the
		// checkpoint and leave the file behind.
		const res = await fetch(`${server.url}/cleanup`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect((await res.json()).deleted).toBe(0);

		const folded = `${server.dbPath}.folded`;
		removeDb(folded);
		copyFileSync(server.dbPath, folded);
		const copied = rowsIn(folded);
		removeDb(folded);

		expect(copied).toBe(INGESTED);
	});
});

describe("the snapshot tool", () => {
	test("writes a complete database while the service keeps serving", async () => {
		const proc = Bun.spawn(["bun", "run", "src/tools/snapshot.ts", snapshotPath], {
			env: { ...process.env, TRACEHUB_DB: server.dbPath },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(`${code} ${err}`).toBe("0 ");
		expect(out).toContain(`${INGESTED} traces`);

		expect(rowsIn(snapshotPath)).toBe(INGESTED);
		expect(statSync(snapshotPath).size).toBeGreaterThan(0);

		// The service was never interrupted to produce it.
		const health = await fetch(`${server.url}/health`);
		expect(health.status).toBe(200);
	});

	test("refuses to overwrite an existing file instead of destroying it", async () => {
		const proc = Bun.spawn(["bun", "run", "src/tools/snapshot.ts", snapshotPath], {
			env: { ...process.env, TRACEHUB_DB: server.dbPath },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(code).toBe(2);
		expect(err).toContain("refusing to overwrite");
	});
});
