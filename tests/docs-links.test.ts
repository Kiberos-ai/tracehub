import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestServer, startServer } from "./helpers";

// /llms.txt is the door an agent walks through: it is a map of what this
// service documents about itself. Measured live on 2026-09-14, that map
// advertised eight documents and six of them answered 404 — an agent following
// it got two pages and six dead ends, and nothing anywhere said so. A map that
// names a page it does not serve is worse than a map with fewer pages, so every
// link it prints is requested here.

let server: TestServer;

beforeAll(async () => {
	server = await startServer("docs-links", 19144);
});

afterAll(async () => {
	await server.stop();
});

/** Every absolute link inside a markdown document, in the order written. */
function linkedPaths(markdown: string): string[] {
	const paths = new Set<string>();
	for (const m of markdown.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
		paths.add(new URL(m[1]).pathname);
	}
	return [...paths];
}

describe("the map an agent is handed", () => {
	test("/llms.txt is served and links to something", async () => {
		const res = await fetch(`${server.url}/llms.txt`);

		expect(res.status).toBe(200);
		const body = await res.text();
		expect(linkedPaths(body).length).toBeGreaterThan(0);
	});

	test("every document /llms.txt advertises is actually served", async () => {
		const body = await (await fetch(`${server.url}/llms.txt`)).text();

		const broken: string[] = [];
		for (const path of linkedPaths(body)) {
			const res = await fetch(`${server.url}${path}`);
			if (res.status !== 200) broken.push(`${path} → ${res.status}`);
		}

		expect(broken).toEqual([]);
	});

	test("every document it serves has real content, not just a heading", async () => {
		const body = await (await fetch(`${server.url}/llms.txt`)).text();

		const thin: string[] = [];
		for (const path of linkedPaths(body)) {
			const text = await (await fetch(`${server.url}${path}`)).text();
			if (text.length < 500) thin.push(`${path} → ${text.length} bytes`);
		}

		expect(thin).toEqual([]);
	});

	test("an unknown page still says where the map is", async () => {
		const res = await fetch(`${server.url}/docs/no-such-page.md`);

		expect(res.status).toBe(404);
		expect(await res.text()).toContain("/llms.txt");
	});
});
