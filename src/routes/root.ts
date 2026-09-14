import { Hono } from "hono";
import { MAX_LONGPOLL_WAIT, TRACEHUB_RETENTION_HOURS } from "../lib/config";

export const rootRouter = new Hono();

const REPOSITORY = "https://github.com/Kiberos-ai/tracehub";
const PUBLIC_URL = "https://tracehub.muid.io/";

/** What a preview card has room for — one sentence, no jargon, no endpoints. */
// Title and card summary are vibe-marketing-owner's copy, taken as written
// (2026-09-03). Two things he changed and why, so nobody "improves" them back:
// the title names the CLASS of thing — "distributed tracing" is the phrase a
// developer actually searches for, and a title that only says what the service
// does leaves them unsure whether it is a debugger, a log or a monitor. And the
// summary leads with the reader's problem rather than a "When …" clause, because
// a preview often cuts the tail and a condition without its conclusion says
// nothing. He measured both at 53 and 163 characters so neither is truncated.
const CARD_TITLE = "TraceHub — distributed tracing you can read by one id";

const CARD_SUMMARY =
	"One operation crosses several services and its story scatters. TraceHub collects " +
	"every checkpoint under a single id and gives the whole run back — complete or live.";

/**
 * What the service answers at its own front door.
 *
 * Until 2026-09-03 this was a bare "404 Not Found": every endpoint worked, and
 * anyone who simply opened the address — a person told about TraceHub, or a
 * crawler deciding whether the host is alive — was told the service was not
 * there. The docs already served at /help/api had no way of being found.
 *
 * A browser gets the page below; anything else gets the same facts as JSON,
 * because the front door of an API is read by machines more often than people.
 */
const ENDPOINTS = [
	{
		path: "/health",
		method: "GET",
		summary: "liveness, database path and retention window",
	},
	{
		path: "/stats",
		method: "GET",
		summary: "uptime, ingest counters, subscribers, database size",
	},
	{
		path: "/ingest",
		method: "POST",
		summary: "send a batch of checkpoints; requires the X-TraceHub-Secret header",
	},
	{
		path: "/traces/{correlation_id}",
		method: "GET",
		summary: `read one operation end to end; ?since_ts= returns only newer traces, and Prefer: wait=N holds an unfinished chain open for up to ${MAX_LONGPOLL_WAIT}s`,
	},
	{
		path: "/traces/{correlation_id}/stream",
		method: "GET",
		summary: "follow an operation live over server-sent events",
	},
	{
		path: "/correlations",
		method: "GET",
		summary: "the most recent operations, newest first",
	},
	{
		path: "/tracing/config",
		method: "GET",
		summary: "adaptive sampling config; long-poll it with Prefer: wait=N and an ETag",
	},
	{
		path: "/help/api/manifest",
		method: "GET",
		summary: "this service's own documentation, in the context777 provider format",
	},
];

const DESCRIPTION =
	"TraceHub is the shared memory of what actually happened during one operation " +
	"that crossed several machines and processes. Services send checkpoints under a " +
	"common correlation_id, and the whole run is read back afterwards — in full, live " +
	"over a stream, or selectively: sampling is adaptive, so a correlation someone " +
	"asks about becomes hot by itself and quietens down the same way.";

function page(): string {
	const rows = ENDPOINTS.map(
		(e) =>
			`<tr><td><code>${e.method}</code></td><td><code>${e.path}</code></td><td>${e.summary}</td></tr>`,
	).join("\n");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${CARD_TITLE}</title>
<meta name="description" content="${CARD_SUMMARY}">
<!-- A shared link is seen as a card before it is seen as a page: without these
     the preview shows a bare address and nobody clicks it. -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="TraceHub">
<meta property="og:title" content="${CARD_TITLE}">
<meta property="og:description" content="${CARD_SUMMARY}">
<meta property="og:url" content="${PUBLIC_URL}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${CARD_TITLE}">
<meta name="twitter:description" content="${CARD_SUMMARY}">
<style>
  :root { color-scheme: light dark; }
  body { max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem;
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 1.9rem; margin-bottom: .25rem; }
  .lede { opacity: .75; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1.5rem 0; }
  td, th { text-align: left; padding: .5rem .6rem; vertical-align: top;
           border-bottom: 1px solid rgba(128,128,128,.28); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
  .licence { font-size: 1.05rem; font-weight: 600; margin: 1.25rem 0 .5rem; }
  footer { margin-top: 2.5rem; opacity: .7; font-size: .92rem; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>TraceHub</h1>
<p class="lede">${DESCRIPTION}</p>

<p class="licence">Apache&nbsp;License&nbsp;2.0 — run your own copy, no permission needed.</p>

<p>Traces are kept for ${TRACEHUB_RETENTION_HOURS} hours. Sending requires a secret;
reading does not.</p>

<table>
<thead><tr><th>Method</th><th>Path</th><th>What it does</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>

<footer>
Source at <a href="${REPOSITORY}">${REPOSITORY}</a> ·
this page is also available as JSON to any client that does not ask for HTML.
</footer>
</body>
</html>
`;
}

/**
 * Who gets the page, and who has to ask for the data.
 *
 * The first version had this backwards: it served HTML only to a client that
 * said `Accept: text/html`, and JSON to everyone else. Measured 2026-09-03 —
 * a full browser got the page, but a link preview, a search crawler and a plain
 * request all got JSON. Those three are exactly how a shared address is first
 * seen by a person, so the shopfront was invisible to the visitors it is for.
 *
 * The page is now the default. Data is served only when it is actually asked
 * for: ?format=json, or an Accept that names JSON without naming HTML.
 */
function wantsJson(accept: string, format: string | undefined): boolean {
	if (format === "json") return true;
	if (accept.includes("text/html")) return false;
	return accept.includes("application/json");
}

rootRouter.get("/", (c) => {
	const accept = c.req.header("Accept") ?? "";

	if (!wantsJson(accept, c.req.query("format"))) {
		return c.html(page());
	}

	return c.json({
		service: "tracehub",
		description: DESCRIPTION,
		license: "Apache-2.0",
		repository: REPOSITORY,
		retention_hours: TRACEHUB_RETENTION_HOURS,
		max_longpoll_wait_seconds: MAX_LONGPOLL_WAIT,
		documentation: "/help/api/manifest",
		endpoints: ENDPOINTS,
	});
});
