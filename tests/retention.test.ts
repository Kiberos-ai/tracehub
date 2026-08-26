import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	type TestServer,
	cleanupDb,
	dbSize,
	getJson,
	makeBloatedDb,
	postJson,
	startServer,
	trace,
} from "./helpers";

// Guardrail under test: deletes-must-reclaim.
// Production once held 1.04 GB of freed pages against zero rows, because DELETE
// alone never returns space and, under WAL, even a VACUUM does not shrink the
// file without a checkpoint.

let server: TestServer | undefined;

afterEach(async () => {
	await server?.stop();
	server = undefined;
});

describe("startup reclaim", () => {
	test("shrinks a database that was left bloated by an earlier build", async () => {
		const dbPath = "./data/test-reclaim.db";
		const bloatedBytes = makeBloatedDb(dbPath, 8000);
		expect(bloatedBytes).toBeGreaterThan(20_000_000);

		server = await startServer("reclaim", 19105, {}, { keepDb: true });

		expect(dbSize(dbPath)).toBeLessThan(bloatedBytes / 10);
		expect(server.stderr()).toContain("Reclaimed");
	}, 30_000);

	test("converts the database to incremental auto_vacuum", async () => {
		server = await startServer("autovac", 19106);
		await postJson(`${server.url}/ingest/single`, trace({ correlation_id: "av", suffix: "av" }));

		const db = new Database(server.dbPath, { readonly: true });
		const mode = (db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum;
		db.close();

		expect(mode).toBe(2); // 2 = INCREMENTAL
	});
});

describe("retention cleanup", () => {
	test("deletes expired traces and hands the pages back", async () => {
		// Retention 0 means every stored trace is already expired.
		server = await startServer("retention", 19107, { TRACEHUB_RETENTION_HOURS: "0" });

		const filler = "y".repeat(2000);
		for (let batch = 0; batch < 4; batch++) {
			await postJson(`${server.url}/ingest`, {
				traces: Array.from({ length: 500 }, (_, i) => {
					const n = batch * 500 + i;
					return trace({
						correlation_id: `bulk-${n}`,
						suffix: `s${n}`,
						timestamp: n,
						data: { filler },
					});
				}),
			});
		}

		const grown = dbSize(server.dbPath);
		expect(grown).toBeGreaterThan(1_000_000);

		const res = await fetch(`${server.url}/cleanup`, { method: "DELETE" });
		expect(res.status).toBe(200);

		expect((await getJson(`${server.url}/correlations`)).count).toBe(0);
		expect(dbSize(server.dbPath)).toBeLessThan(grown / 2);
	}, 30_000);
});

describe("retention's own scan", () => {
	// The hourly DELETE selects on created_at. Without an index on that column
	// SQLite reads every row of the table to find the expired ones — cheap on an
	// idle instance, and exactly what a busy one cannot afford. The index leads
	// with created_at and carries correlation_id for the /correlations walk, so
	// this DELETE and that walk share one index instead of keeping two.
	test("finds expired rows through an index instead of scanning the table", async () => {
		server = await startServer("retention-plan", 19108);
		await postJson(`${server.url}/ingest/single`, trace({ correlation_id: "p", suffix: "p" }));

		// The real statement, not a stand-in: EXPLAIN QUERY PLAN plans it without
		// running it, so nothing is deleted here.
		const db = new Database(server.dbPath);
		const plan = db
			.query("EXPLAIN QUERY PLAN DELETE FROM traces WHERE created_at < ?")
			.all(0) as Array<{ detail: string }>;
		db.close();

		const detail = plan.map((row) => row.detail).join(" | ");
		expect(detail).toMatch(/USING (COVERING )?INDEX idx_created_at_correlation/);
		expect(detail).not.toContain("SCAN traces");
	});
});

describe("database location", () => {
	// Guardrail: db-outside-tmp. The default must not be a path wiped on reboot.
	test("defaults outside /tmp", async () => {
		const { TRACEHUB_DB } = await import("../src/lib/config");
		expect(TRACEHUB_DB.startsWith("/tmp")).toBe(false);
	});
});

// Leave no test databases behind even if a test threw mid-way.
afterEach(() => {
	for (const name of ["reclaim", "autovac", "retention", "retention-plan"]) {
		cleanupDb(`./data/test-${name}.db`);
	}
});
