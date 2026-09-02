import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestServer, startServer } from "./helpers";

let server: TestServer;

beforeAll(async () => {
	server = await startServer("root-visitors", 19111);
});

afterAll(async () => {
	await server.stop();
});

// The first front door served HTML only when a client said `Accept: text/html`
// and JSON to everyone else. Measured on the live service 2026-09-03 by
// vibe-marketing-owner: a full browser got the page, but a link preview, a
// search crawler and a plain request all got 1560 bytes of JSON. Those three
// are how a shared address is first seen by a person, so the shopfront was
// invisible to exactly the visitors it exists for. The page is the default now.

const HUMAN_FACING = [
	{
		who: "a link preview (Telegram, Slack, anything that unfurls)",
		headers: { "User-Agent": "TelegramBot (like TwitterBot)" },
	},
	{
		who: "a search crawler",
		headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
	},
	{
		who: "a plain request that states no preference",
		headers: { Accept: "*/*" },
	},
	{
		who: "a browser",
		headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
	},
	{
		who: "a client sending no Accept at all",
		headers: {},
	},
];

describe("who the front door answers with a page", () => {
	for (const visitor of HUMAN_FACING) {
		test(`${visitor.who} gets HTML`, async () => {
			const res = await fetch(`${server.url}/`, { headers: visitor.headers });

			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/html");
			expect(await res.text()).toContain("<title>");
		});
	}
});

describe("a shared address has to survive being a card before it is a page", () => {
	test("the page carries a title, a description and preview fields", async () => {
		const html = await (await fetch(`${server.url}/`)).text();

		expect(html).toMatch(/<title>[^<]{20,}<\/title>/);
		expect(html).toContain('name="description"');
		expect(html).toContain('property="og:title"');
		expect(html).toContain('property="og:description"');
		expect(html).toContain('property="og:url"');
		expect(html).toContain('name="twitter:card"');
	});

	test("the card summary says what the service does without naming an endpoint", async () => {
		const html = await (await fetch(`${server.url}/`)).text();
		const card = html.match(/property="og:description" content="([^"]+)"/)?.[1] ?? "";

		expect(card.length).toBeGreaterThan(80);
		expect(card).not.toContain("/traces");
		expect(card).not.toContain("GET");
	});
});

describe("data is still reachable, but only when asked for", () => {
	test("Accept: application/json returns the descriptor", async () => {
		const res = await fetch(`${server.url}/`, { headers: { Accept: "application/json" } });

		expect(res.headers.get("content-type")).toContain("application/json");
		expect((await res.json()).service).toBe("tracehub");
	});

	test("?format=json works for a client that cannot set headers", async () => {
		const res = await fetch(`${server.url}/?format=json`);

		expect(res.headers.get("content-type")).toContain("application/json");
		expect((await res.json()).license).toBe("Apache-2.0");
	});

	test("a browser that also accepts JSON still gets the page", async () => {
		// Browsers send */* alongside text/html; naming HTML must win.
		const res = await fetch(`${server.url}/`, {
			headers: { Accept: "text/html,application/json;q=0.9" },
		});

		expect(res.headers.get("content-type")).toContain("text/html");
	});
});
