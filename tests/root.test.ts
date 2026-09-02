import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestServer, startServer } from "./helpers";

let server: TestServer;

beforeAll(async () => {
	server = await startServer("root", 19110);
});

afterAll(async () => {
	await server.stop();
});

// Until 2026-09-03 the front door answered a bare "404 Not Found" while every
// endpoint behind it worked. A neighbour walking the fleet's public addresses
// found it: the service looked absent to anyone who simply opened it, and the
// documentation already served at /help/api had no way of being discovered.

describe("the service's front door", () => {
	test("a browser gets a page, not a 404", async () => {
		const res = await fetch(`${server.url}/`, { headers: { Accept: "text/html" } });

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");

		const html = await res.text();
		expect(html).toContain("TraceHub");
		expect(html).toContain("/help/api/manifest");
		expect(html).toContain("Apache");
	});

	test("anything that does not ask for HTML gets the same facts as JSON", async () => {
		const res = await fetch(`${server.url}/`);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");

		const body = await res.json();
		expect(body.service).toBe("tracehub");
		expect(body.license).toBe("Apache-2.0");
		expect(body.documentation).toBe("/help/api/manifest");
		expect(Array.isArray(body.endpoints)).toBe(true);
	});

	test("every path the front door advertises is one this service really serves", async () => {
		// The failure this guards: the page drifts from the routes and sends
		// readers at endpoints that answer 404 — worse than saying nothing.
		const body = await (await fetch(`${server.url}/`)).json();

		for (const entry of body.endpoints) {
			if (entry.method !== "GET") continue;
			// Fill in a placeholder so templated paths resolve to a real request.
			const path = entry.path.replace("{correlation_id}", "probe-correlation");

			const res = await fetch(`${server.url}${path}`, {
				headers: { Accept: "application/json" },
				// The streaming endpoint never completes on its own.
				signal: AbortSignal.timeout(2000),
			}).catch((err: Error) => err);

			if (res instanceof Error) {
				// A timeout means the route exists and is holding the connection.
				expect(res.name).toBe("TimeoutError");
				continue;
			}

			expect(res.status, `${entry.path} is advertised but answers ${res.status}`).not.toBe(404);
			await res.body?.cancel();
		}
	});

	test("the front door does not shadow the routes mounted after it", async () => {
		const health = await fetch(`${server.url}/health`);
		expect(health.status).toBe(200);
		expect((await health.json()).service).toBe("tracehub");
	});
});
