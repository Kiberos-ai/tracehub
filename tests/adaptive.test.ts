import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestServer, getJson, postJson, startServer, trace } from "./helpers";

// Adaptive sampling is the feature the whole design rests on: attention decides
// what gets traced. These run with second-scale TTLs so the decay is observable.

let server: TestServer;

beforeAll(async () => {
	server = await startServer("adaptive", 19108, {
		ADAPTIVE_HOT_TTL: "2",
		ADAPTIVE_WARM_TTL: "2",
		ADAPTIVE_TICK_INTERVAL: "1",
		ADAPTIVE_WARM_RATE: "0.25",
		// These tests poll /tracing/config well past its 10/min production limit.
		// Rate limiting has its own file; here it would only make this one flaky.
		TRACEHUB_RATE_CONFIG: "10000",
		TRACEHUB_RATE_QUERY: "10000",
	});
});

afterAll(async () => {
	await server.stop();
});

async function stateOf(corrId: string): Promise<string | undefined> {
	const { correlations } = await getJson(`${server.url}/tracing/status`);
	return correlations.find((c: { correlation_id: string }) => c.correlation_id === corrId)?.state;
}

describe("attention drives sampling", () => {
	test("querying a correlation makes it hot and says so once", async () => {
		await postJson(
			`${server.url}/ingest/single`,
			trace({ correlation_id: "watch-me", suffix: "w1" }),
		);

		const first = await getJson(`${server.url}/traces/watch-me`);
		expect(first.adaptive_hint.previous_state).toBe("cold");
		expect(first.adaptive_hint.current_state).toBe("hot");

		// Already hot — the hint is for the transition, not every read.
		const second = await getJson(`${server.url}/traces/watch-me`);
		expect(second.adaptive_hint).toBeUndefined();

		expect(await stateOf("watch-me")).toBe("hot");
	});

	test("config advertises hot correlations at full rate", async () => {
		await getJson(`${server.url}/traces/in-config`);

		const config = await getJson(`${server.url}/tracing/config`);
		expect(config.mode).toBe("adaptive");
		expect(config.hot_correlations["in-config"].rate).toBe(1.0);
		expect(config.default_rate).toBe(0);
	});

	test("can be forced hot and cold explicitly", async () => {
		await postJson(`${server.url}/tracing/enable/manual`, {});
		expect(await stateOf("manual")).toBe("hot");

		await postJson(`${server.url}/tracing/disable/manual`, {});
		expect(await stateOf("manual")).toBeUndefined();
	});

	test(
		"decays hot -> warm -> gone without anyone asking again",
		async () => {
			await postJson(`${server.url}/tracing/enable/decaying`, {});
			expect(await stateOf("decaying")).toBe("hot");

			await Bun.sleep(3500); // past HOT_TTL=2s
			expect(await stateOf("decaying")).toBe("warm");

			await Bun.sleep(3500); // past WARM_TTL=2s
			expect(await stateOf("decaying")).toBeUndefined();
		},
		20_000,
	);
});

describe("config delivery", () => {
	test("returns 304 for an unchanged etag", async () => {
		const first = await fetch(`${server.url}/tracing/config`);
		const etag = first.headers.get("etag");
		expect(etag).toBeTruthy();

		const second = await fetch(`${server.url}/tracing/config`, {
			headers: { "If-None-Match": etag as string },
		});
		expect(second.status).toBe(304);
	});

	test("answers immediately when the client sends no Prefer header", async () => {
		const started = Date.now();
		const res = await fetch(`${server.url}/tracing/config`);

		expect(res.status).toBe(200);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test(
		"long-poll waits, then returns 304 when nothing changed",
		async () => {
			const first = await fetch(`${server.url}/tracing/config`);
			const etag = first.headers.get("etag") as string;

			const started = Date.now();
			const res = await fetch(`${server.url}/tracing/config`, {
				headers: { "If-None-Match": etag, Prefer: "wait=2" },
			});
			const waited = Date.now() - started;

			expect(res.status).toBe(304);
			expect(waited).toBeGreaterThan(1500);
		},
		15_000,
	);

	test(
		"long-poll wakes as soon as the config changes",
		async () => {
			const first = await fetch(`${server.url}/tracing/config`);
			const etag = first.headers.get("etag") as string;

			const started = Date.now();
			const waiting = fetch(`${server.url}/tracing/config`, {
				headers: { "If-None-Match": etag, Prefer: "wait=20" },
			});

			await Bun.sleep(300);
			await postJson(`${server.url}/tracing/enable/wakes-the-poll`, {});

			const res = await waiting;
			const waited = Date.now() - started;

			expect(res.status).toBe(200);
			expect(waited).toBeLessThan(5000);
			expect((await res.json()).hot_correlations["wakes-the-poll"]).toBeDefined();
		},
		30_000,
	);
});
