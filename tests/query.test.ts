import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestServer, getJson, postJson, readUntil, startServer, trace } from "./helpers";

let server: TestServer;

beforeAll(async () => {
	server = await startServer("query", 19102);
	await postJson(`${server.url}/ingest`, {
		traces: [
			trace({ correlation_id: "chain", suffix: "q1", timestamp: 100, endpoint: "/first" }),
			trace({
				correlation_id: "chain",
				suffix: "q2",
				timestamp: 200,
				endpoint: "/second",
				source_id: "OTHER",
			}),
			trace({ correlation_id: "lonely", suffix: "q3", timestamp: 300 }),
		],
	});
});

afterAll(async () => {
	await server.stop();
});

describe("querying a correlation", () => {
	test("returns the whole chain in timestamp order", async () => {
		const res = await getJson(`${server.url}/traces/chain`);

		expect(res.count).toBe(2);
		expect(res.traces.map((t: { endpoint: string }) => t.endpoint)).toEqual(["/first", "/second"]);
	});

	test("filters by source", async () => {
		const res = await getJson(`${server.url}/traces/chain?source=OTHER`);

		expect(res.count).toBe(1);
		expect(res.traces[0].source_id).toBe("OTHER");
	});

	test("returns an empty result for an unknown id rather than failing", async () => {
		const res = await getJson(`${server.url}/traces/nothing-here`);
		expect(res.count).toBe(0);
	});
});

describe("listing", () => {
	test("correlations reports each chain with its sources", async () => {
		const { correlations, count } = await getJson(`${server.url}/correlations`);

		expect(count).toBeGreaterThanOrEqual(2);
		const chain = correlations.find(
			(c: { correlation_id: string }) => c.correlation_id === "chain",
		);
		expect(chain.trace_count).toBe(2);
		expect(chain.sources.sort()).toEqual(["OTHER", "TS"]);
	});

	test("recent returns traces across correlations", async () => {
		const { count } = await getJson(`${server.url}/recent?limit=10`);
		expect(count).toBe(3);
	});
});

describe("SSE streaming", () => {
	test("delivers a trace ingested after the client subscribed", async () => {
		const controller = new AbortController();
		const res = await fetch(`${server.url}/traces/live-sse/stream`, {
			signal: controller.signal,
		});
		expect(res.headers.get("content-type")).toContain("text/event-stream");

		const reader = (res.body as ReadableStream<Uint8Array>).getReader();

		await postJson(
			`${server.url}/ingest/single`,
			trace({ correlation_id: "live-sse", suffix: "sse", endpoint: "/streamed" }),
		);

		const received = await readUntil(reader, "/streamed");
		controller.abort();

		expect(received).toContain("/streamed");
	}, 15_000);
});

// =============================================================================
// Incremental reads
//
// Its own server: these traces would change the counts the tests above assert.
// =============================================================================

describe("reading a correlation incrementally", () => {
	let inc: TestServer;

	beforeAll(async () => {
		inc = await startServer("query-incremental", 19103);
		await postJson(`${inc.url}/ingest`, {
			traces: [
				trace({ correlation_id: "pair", suffix: "in", timestamp: 100, direction: "->" }),
				trace({ correlation_id: "pair", suffix: "out", timestamp: 200, direction: "<-" }),
			],
		});
	});

	afterAll(async () => {
		await inc.stop();
	});

	test("since_ts returns only what is newer, and completeness still counts the whole chain", async () => {
		const res = await getJson(`${inc.url}/traces/pair?since_ts=100`);

		expect(res.count).toBe(1);
		expect(res.traces[0].suffix).toBe("out");
		// The caller asked for a slice; the chain it belongs to is still complete.
		expect(res.complete).toBe(true);
	});

	test("a since_ts past the last trace returns nothing without claiming the chain is unfinished", async () => {
		const res = await getJson(`${inc.url}/traces/pair?since_ts=200`);

		expect(res.count).toBe(0);
		expect(res.complete).toBe(true);
	});
});
