import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestServer, postJson, startServer, trace } from "./helpers";

// Rate limiting is what keeps one misbehaving client from drowning the service.
// Limits are set low here so the boundary is reached in a handful of requests.

let server: TestServer;

beforeAll(async () => {
	server = await startServer("ratelimit", 19109, {
		TRACEHUB_RATE_CONFIG: "5",
		TRACEHUB_RATE_INGEST: "5",
		TRACEHUB_RATE_QUERY: "5",
	});
});

afterAll(async () => {
	await server.stop();
});

/** Send `n` requests in order and return the status codes. */
async function hammer(path: string, n: number, client: string): Promise<number[]> {
	const codes: number[] = [];
	for (let i = 0; i < n; i++) {
		const res = await fetch(`${server.url}${path}`, { headers: { "X-TraceHub-Client": client } });
		codes.push(res.status);
	}
	return codes;
}

describe("per-client limits", () => {
	test("allows the quota and then answers 429", async () => {
		const codes = await hammer("/tracing/config", 8, "greedy");

		expect(codes.slice(0, 5).every((c) => c === 200 || c === 304)).toBe(true);
		expect(codes.slice(5)).toEqual([429, 429, 429]);
	});

	test("tells a throttled client when to come back", async () => {
		await hammer("/tracing/config", 6, "retry-reader");
		const res = await fetch(`${server.url}/tracing/config`, {
			headers: { "X-TraceHub-Client": "retry-reader" },
		});

		expect(res.status).toBe(429);
		expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
	});

	test("throttles one client without touching another", async () => {
		await hammer("/tracing/config", 8, "noisy");

		const res = await fetch(`${server.url}/tracing/config`, {
			headers: { "X-TraceHub-Client": "quiet" },
		});
		expect([200, 304]).toContain(res.status);
	});

	test("limits ingest separately from reads", async () => {
		for (let i = 0; i < 5; i++) {
			await postJson(
				`${server.url}/ingest/single`,
				trace({ correlation_id: `rl-${i}`, suffix: `r${i}` }),
				{ "X-TraceHub-Client": "writer" },
			);
		}

		const overflow = await postJson(
			`${server.url}/ingest/single`,
			trace({ correlation_id: "rl-over", suffix: "ro" }),
			{ "X-TraceHub-Client": "writer" },
		);
		expect(overflow.status).toBe(429);

		// The same client's reads are governed by their own budget.
		const read = await fetch(`${server.url}/health`, {
			headers: { "X-TraceHub-Client": "writer" },
		});
		expect(read.status).toBe(200);
	});
});
