import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestServer, getJson, postJson, startServer, trace } from "./helpers";

let server: TestServer;

beforeAll(async () => {
	server = await startServer("ingest", 19101);
});

afterAll(async () => {
	await server.stop();
});

describe("ingest", () => {
	test("accepts a batch and stores every trace", async () => {
		const res = await postJson(`${server.url}/ingest`, {
			traces: [
				trace({ correlation_id: "batch-1", suffix: "b1" }),
				trace({ correlation_id: "batch-2", suffix: "b2" }),
			],
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ accepted: 2, inserted: 2, duplicates: 0 });

		const stored = await getJson(`${server.url}/traces/batch-1`);
		expect(stored.count).toBe(1);
		expect(stored.traces[0].endpoint).toBe("/api/test");
	});

	test("accepts a single trace", async () => {
		const res = await postJson(
			`${server.url}/ingest/single`,
			trace({ correlation_id: "single-1", suffix: "s1" }),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ inserted: true });
	});

	test("rejects a malformed trace", async () => {
		const res = await postJson(`${server.url}/ingest/single`, { source_id: "TS" });
		expect(res.status).toBe(400);
	});
});

describe("stats counters", () => {
	// Regression: /ingest used to add to the counters that insertTrace had already
	// incremented, so a batch of N traces reported 2N.
	test("count each received trace exactly once", async () => {
		const before = (await getJson(`${server.url}/stats`)).requests.ingest_total;

		await postJson(`${server.url}/ingest`, {
			traces: [
				trace({ correlation_id: "count-1", suffix: "c1" }),
				trace({ correlation_id: "count-2", suffix: "c2" }),
				trace({ correlation_id: "count-3", suffix: "c3" }),
			],
		});

		const after = (await getJson(`${server.url}/stats`)).requests.ingest_total;
		expect(after - before).toBe(3);
	});

	// Regression: the route filed every non-inserted trace under "duplicates",
	// collapsing it with the 5-minute-window dedup that insertTrace tracks apart.
	test("separate a window dedup from a constraint duplicate", async () => {
		const body = {
			traces: [trace({ correlation_id: "dedup-1", suffix: "d1", endpoint: "/dedup" })],
		};
		await postJson(`${server.url}/ingest`, body);

		const before = (await getJson(`${server.url}/stats`)).requests;
		await postJson(`${server.url}/ingest`, body);
		const after = (await getJson(`${server.url}/stats`)).requests;

		expect(after.ingest_deduped - before.ingest_deduped).toBe(1);
		expect(after.ingest_duplicates - before.ingest_duplicates).toBe(0);

		// ...and the repeat updated the existing row rather than adding one.
		const stored = await getJson(`${server.url}/traces/dedup-1`);
		expect(stored.count).toBe(1);
	});
});

describe("per-source tracking", () => {
	// Regression: /ingest/single skipped this, so a service that only ever sent
	// single traces never appeared in /stats/sources at all.
	test("record sources from both the batch and the single route", async () => {
		await postJson(`${server.url}/ingest`, {
			traces: [trace({ source_id: "BATCHSRC", correlation_id: "src-b", suffix: "sb" })],
		});
		await postJson(
			`${server.url}/ingest/single`,
			trace({ source_id: "SINGLESRC", correlation_id: "src-s", suffix: "ss" }),
		);

		const { sources } = await getJson(`${server.url}/stats/sources`);
		const ids = sources.map((s: { source_id: string }) => s.source_id);

		expect(ids).toContain("BATCHSRC");
		expect(ids).toContain("SINGLESRC");
	});
});
