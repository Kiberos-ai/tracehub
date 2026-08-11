import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestServer, postJson, startServer, trace } from "./helpers";

// Guardrail under test: auth-scoped-to-ingest.
// It was once mounted globally (fixed in 3fdfe68) and locked every reader out
// of health, query and docs. These tests exist so that cannot come back quietly.

const SECRET = "test-secret-value";
let server: TestServer;

beforeAll(async () => {
	server = await startServer("auth", 19104, { TRACEHUB_SECRET: SECRET });
});

afterAll(async () => {
	await server.stop();
});

describe("ingest is protected", () => {
	test("rejects a missing secret with 401", async () => {
		const res = await postJson(`${server.url}/ingest`, { traces: [trace()] });
		expect(res.status).toBe(401);
	});

	test("rejects a wrong secret with 403", async () => {
		const res = await postJson(
			`${server.url}/ingest`,
			{ traces: [trace()] },
			{ "X-TraceHub-Secret": "wrong" },
		);
		expect(res.status).toBe(403);
	});

	test("accepts the right secret", async () => {
		const res = await postJson(
			`${server.url}/ingest`,
			{ traces: [trace({ correlation_id: "authed", suffix: "au" })] },
			{ "X-TraceHub-Secret": SECRET },
		);
		expect(res.status).toBe(200);
	});

	test("protects the single-ingest route too", async () => {
		const res = await postJson(`${server.url}/ingest/single`, trace());
		expect(res.status).toBe(401);
	});
});

describe("everything else stays open", () => {
	const openPaths = [
		"/health",
		"/stats",
		"/stats/sources",
		"/correlations",
		"/recent",
		"/traces/authed",
		"/tracing/config",
		"/tracing/status",
		"/llms.txt",
		"/help/api/manifest",
	];

	for (const path of openPaths) {
		test(`${path} needs no secret`, async () => {
			const res = await fetch(`${server.url}${path}`);
			expect(res.status).toBe(200);
		});
	}
});
