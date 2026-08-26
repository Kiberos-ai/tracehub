import { afterAll, beforeAll, expect, test } from "bun:test";
import { type TestServer, readUntil, startServer } from "./helpers";

// =============================================================================
// Long-lived connections must outlive the runtime's idle timeout.
//
// Both of this service's push mechanisms hold a connection open with nothing
// on it: the SSE stream between heartbeats, and the /tracing/config long poll
// while the config is unchanged. Bun.serve closes an idle connection after its
// own default (measured at 12s on bun 1.3.14), which is shorter than either —
// the SSE heartbeat is 15s and a long poll may ask for up to 60s.
//
// The failure is silent by construction: the client sees a dropped socket, not
// an answer, so it reconnects. Long polling then degrades into exactly the busy
// polling it was built to remove — which is why this is covered by a test that
// costs real seconds rather than left to a live probe nobody repeats.
// =============================================================================

const IDLE_FLOOR_MS = 12_000;

let server: TestServer;

beforeAll(async () => {
	server = await startServer("longlived", 19110);
});

afterAll(async () => {
	await server.stop();
});

test("an SSE stream on a silent correlation survives to its first heartbeat", async () => {
	const res = await fetch(`${server.url}/traces/silent-corr/stream?timeout=60`);
	expect(res.status).toBe(200);

	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	const started = Date.now();
	// The heartbeat is at 15s — past the idle floor, which is the whole point.
	const seen = await readUntil(reader, ": ping", 20_000);
	const elapsed = Date.now() - started;

	reader.cancel().catch(() => {});

	expect(seen).toContain(": ping");
	expect(elapsed).toBeGreaterThan(IDLE_FLOOR_MS);
}, 30_000);

test("a correlation read held past the idle floor answers instead of dropping", async () => {
	const started = Date.now();
	const res = await fetch(`${server.url}/traces/never-starts?since_ts=0`, {
		headers: { Prefer: "wait=15" },
	});
	const elapsed = Date.now() - started;
	const body = (await res.json()) as { count: number };

	// Nothing is ever ingested for this correlation, so the wait runs its full
	// course and ends in an empty 200 — a dropped socket throws above instead.
	expect(res.status).toBe(200);
	expect(body.count).toBe(0);
	expect(elapsed).toBeGreaterThan(IDLE_FLOOR_MS);
}, 30_000);

test("a long poll held past the idle floor answers instead of dropping", async () => {
	const first = await fetch(`${server.url}/tracing/config`);
	const etag = first.headers.get("ETag") ?? '"0"';

	const started = Date.now();
	const res = await fetch(`${server.url}/tracing/config`, {
		headers: { "If-None-Match": etag, Prefer: "wait=15" },
	});
	const elapsed = Date.now() - started;

	// Nothing changes the config here, so the wait must run its full course
	// and end in a 304 — a dropped socket throws above and never reaches this.
	expect(res.status).toBe(304);
	expect(elapsed).toBeGreaterThan(IDLE_FLOOR_MS);
}, 30_000);
