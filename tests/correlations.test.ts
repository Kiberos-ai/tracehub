import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	type TestServer,
	cleanupDb,
	getJson,
	makeBusyDb,
	postJson,
	startServer,
	trace,
} from "./helpers";

// =============================================================================
// /correlations must not pay for the whole retention window on every call.
//
// The route used to GROUP BY the entire table and apply LIMIT afterwards, so a
// browse of the newest 50 chains read every trace of the last 24 hours. Measured
// on 1,000,000 rows / 200,000 correlations: 116.9 ms, and linear in rows. No
// index fixes that — (correlation_id, created_at) measured 239.8 ms against a
// plain 235.0 ms, and a fully covering one 210.2 ms — because the cost is the
// grouping, not the lookup.
//
// It is now a loose index scan: one seek per distinct second, one more per
// distinct chain inside it. 0.10 ms on the same data.
//
// Two shapes are measured here, because the second one is what a naive fix gets
// wrong. A keyset walk down created_at looks right and measures well on spread
// traffic, yet on ONE chain owning the newest 200,000 rows it took 1.8 s — 81x
// SLOWER than the whole-table statement it replaced. Only the loud-shape test
// below tells those two implementations apart.
// =============================================================================

let server: TestServer;

beforeAll(async () => {
	server = await startServer("correlations", 19112);
});

afterAll(async () => {
	await server.stop();
});

describe("listing correlations", () => {
	test("reports each chain newest-first with its counts and sources", async () => {
		await postJson(`${server.url}/ingest`, {
			traces: [
				trace({ correlation_id: "older", suffix: "o1", timestamp: 10 }),
				trace({ correlation_id: "older", suffix: "o2", timestamp: 20, source_id: "OTHER" }),
			],
		});
		await postJson(`${server.url}/ingest`, {
			traces: [trace({ correlation_id: "newer", suffix: "n1", timestamp: 30 })],
		});

		const { correlations } = await getJson(`${server.url}/correlations`);
		const ids = correlations.map((c: { correlation_id: string }) => c.correlation_id);

		// "newer" was ingested last, so it leads.
		expect(ids.indexOf("newer")).toBeLessThan(ids.indexOf("older"));

		const older = correlations.find(
			(c: { correlation_id: string }) => c.correlation_id === "older",
		);
		expect(older.trace_count).toBe(2);
		expect(older.sources.sort()).toEqual(["OTHER", "TS"]);
		expect(older.first_ts).toBe(10);
		expect(older.last_ts).toBe(20);
		expect(older.duration_ms).toBe(10);
	});

	test("respects limit and caps it", async () => {
		const one = await getJson(`${server.url}/correlations?limit=1`);
		expect(one.count).toBe(1);

		// Over the cap is clamped, not refused.
		const huge = await getJson(`${server.url}/correlations?limit=99999`);
		expect(huge.count).toBeGreaterThan(0);
	});
});

describe("the cost of listing", () => {
	for (const shape of ["spread", "loud"] as const) {
		test(`costs a fraction of aggregating the whole table (${shape} traffic)`, async () => {
			// Self-calibrating on purpose: the same machine times the whole-table
			// aggregate this route used to run, so a slow CI runner moves both numbers
			// and the ratio still means what it says. A fixed millisecond budget would
			// only measure the runner.
			const busyPath = `./data/test-correlations-${shape}.db`;
			const rows = makeBusyDb(busyPath, 30_000, 5, shape);
			expect(rows).toBe(shape === "loud" ? 300_000 : 150_000);

			const port = shape === "spread" ? 19113 : 19114;
			const busy = await startServer(`correlations-${shape}`, port, {}, { keepDb: true });
			try {
				const db = new Database(busy.dbPath);
				const wholeTable = db.query(`
					SELECT correlation_id, COUNT(*) as trace_count, MIN(timestamp) as first_ts,
						   MAX(timestamp) as last_ts, GROUP_CONCAT(DISTINCT source_id) as sources
					FROM traces GROUP BY correlation_id ORDER BY MAX(created_at) DESC LIMIT ?`);
				wholeTable.all(50);
				const t0 = Bun.nanoseconds();
				wholeTable.all(50);
				const aggregateMs = (Bun.nanoseconds() - t0) / 1e6;
				db.close();

				await getJson(`${busy.url}/correlations?limit=50`); // warm the route
				const t1 = Bun.nanoseconds();
				const { count, correlations } = await getJson(`${busy.url}/correlations?limit=50`);
				const routeMs = (Bun.nanoseconds() - t1) / 1e6;

				expect(count).toBe(50);
				expect(
					new Set(correlations.map((c: { correlation_id: string }) => c.correlation_id)).size,
				).toBe(50);
				if (shape === "loud") {
					expect(correlations[0].correlation_id).toBe("loud");
				}
				// The margins differ because the two shapes bound differently, and
				// measuring one of them told us so. On spread traffic the whole answer
				// is cheap, so the route wins by orders of magnitude and only the HTTP
				// round trip keeps it from showing. On loud traffic the answer itself
				// contains a 150,000-trace chain whose count and span must be computed
				// either way: the id walk costs 1.3 ms and that aggregate 20.5 ms, so
				// beating the whole-table statement at all is the honest bar. It still
				// separates the implementations by a mile — the keyset walk this
				// replaced took 1.8 s where the aggregate took 22.7 ms.
				expect(routeMs * (shape === "spread" ? 5 : 1)).toBeLessThan(aggregateMs);
			} finally {
				await busy.stop();
				cleanupDb(busyPath);
			}
		}, 180_000);
	}

	test("still returns enough chains when the newest traces all belong to one of them", async () => {
		// Correctness twin of the loud measurement above: the answer must be full,
		// not merely fast. A pager that stops at its first page returns one chain.
		const loud = Array.from({ length: 1200 }, (_, i) =>
			trace({ correlation_id: "loud", suffix: `l${i}`, timestamp: 1000 + i }),
		);
		await postJson(`${server.url}/ingest`, { traces: loud });

		const { correlations } = await getJson(`${server.url}/correlations?limit=3`);
		const ids = correlations.map((c: { correlation_id: string }) => c.correlation_id);

		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(3);
		expect(ids).toContain("loud");
	}, 20_000);

	test("a chain buried under many newer ones is still reachable by asking for more", async () => {
		const { correlations } = await getJson(`${server.url}/correlations?limit=50`);
		const ids = correlations.map((c: { correlation_id: string }) => c.correlation_id);

		expect(ids).toContain("older");
		expect(ids).toContain("newer");
		expect(ids).toContain("loud");
	});
});
