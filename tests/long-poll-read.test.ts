import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestServer, getJson, postJson, startServer, trace } from "./helpers";

// =============================================================================
// Reading a correlation may WAIT for the next trace instead of answering empty.
//
// Without this, a caller following a chain that has not finished has only one
// move left: ask again, and again. That is the busy polling /tracing/config was
// given a long poll to remove, and it is what the kiberos hook still does on
// every tool call. Same contract as there — `Prefer: wait=N`, capped server-side
// — so a client that already speaks one speaks both.
// =============================================================================

let server: TestServer;

beforeAll(async () => {
	server = await startServer("longpoll-read", 19111);
});

afterAll(async () => {
	await server.stop();
});

describe("Prefer: wait on a correlation read", () => {
	test("answers the moment a matching trace arrives", async () => {
		const started = Date.now();
		const pending = fetch(`${server.url}/traces/awaited?since_ts=0`, {
			headers: { Prefer: "wait=10" },
		});

		// Nothing exists yet, so the read is holding. Send the trace it waits for.
		await Bun.sleep(300);
		await postJson(`${server.url}/ingest`, {
			traces: [trace({ correlation_id: "awaited", suffix: "w1", timestamp: 100 })],
		});

		const body = (await (await pending).json()) as { count: number; traces: { suffix: string }[] };
		const elapsed = Date.now() - started;

		expect(body.count).toBe(1);
		expect(body.traces[0].suffix).toBe("w1");
		// It must be the arrival that ends the wait, not the 10s cap.
		expect(elapsed).toBeLessThan(5_000);
	}, 20_000);

	test("is not woken by a trace on another correlation", async () => {
		const started = Date.now();
		const pending = fetch(`${server.url}/traces/mine?since_ts=0`, {
			headers: { Prefer: "wait=3" },
		});

		await Bun.sleep(300);
		await postJson(`${server.url}/ingest`, {
			traces: [trace({ correlation_id: "someone-else", suffix: "x1", timestamp: 100 })],
		});

		const body = (await (await pending).json()) as { count: number };
		const elapsed = Date.now() - started;

		// The wait ran its full course and returned empty — a wake on somebody
		// else's trace would have ended it at the 300ms mark instead.
		expect(body.count).toBe(0);
		expect(elapsed).toBeGreaterThanOrEqual(2_800);
	}, 20_000);

	test("returns an empty answer when the wait expires, never an error", async () => {
		const started = Date.now();
		const res = await fetch(`${server.url}/traces/never-comes?since_ts=0`, {
			headers: { Prefer: "wait=2" },
		});
		const elapsed = Date.now() - started;
		const body = (await res.json()) as { count: number; complete: boolean };

		expect(res.status).toBe(200);
		expect(body.count).toBe(0);
		expect(elapsed).toBeGreaterThanOrEqual(1_800);
	}, 20_000);

	test("does not wait when the slice already has something to return", async () => {
		await postJson(`${server.url}/ingest`, {
			traces: [trace({ correlation_id: "has-data", suffix: "h1", timestamp: 100 })],
		});

		const started = Date.now();
		const body = await getJsonWithWait(`${server.url}/traces/has-data`, 10);
		const elapsed = Date.now() - started;

		expect(body.count).toBe(1);
		expect(elapsed).toBeLessThan(1_000);
	}, 20_000);

	test("does not hold a caller on a chain that is already complete", async () => {
		await postJson(`${server.url}/ingest`, {
			traces: [
				trace({ correlation_id: "finished", suffix: "f1", timestamp: 100, direction: "->" }),
				trace({ correlation_id: "finished", suffix: "f2", timestamp: 200, direction: "<-" }),
			],
		});

		const started = Date.now();
		// since_ts past the last trace: the slice is empty, but nothing more is coming.
		const body = await getJsonWithWait(`${server.url}/traces/finished?since_ts=300`, 10);
		const elapsed = Date.now() - started;

		expect(body.count).toBe(0);
		expect(body.complete).toBe(true);
		expect(elapsed).toBeLessThan(1_000);
	}, 20_000);

	test("without the header the read answers at once, as it always did", async () => {
		const started = Date.now();
		const body = await getJson(`${server.url}/traces/nothing-at-all`);
		const elapsed = Date.now() - started;

		expect(body.count).toBe(0);
		expect(elapsed).toBeLessThan(1_000);
	});
});

/** GET a correlation asking to wait, and read the JSON body. */
async function getJsonWithWait(
	url: string,
	waitSeconds: number,
	// biome-ignore lint/suspicious/noExplicitAny: test helper reads ad-hoc response shapes
): Promise<any> {
	const res = await fetch(url, { headers: { Prefer: `wait=${waitSeconds}` } });
	return await res.json();
}
