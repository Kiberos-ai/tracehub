import { Hono } from "hono";
import { MAX_LONGPOLL_WAIT, TRACEHUB_RETENTION_HOURS } from "../lib/config";

export const rootRouter = new Hono();

const REPOSITORY = "https://github.com/Kiberos-ai/tracehub";

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
<title>TraceHub</title>
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
  footer { margin-top: 2.5rem; opacity: .7; font-size: .92rem; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>TraceHub</h1>
<p class="lede">${DESCRIPTION}</p>

<p>Traces are kept for ${TRACEHUB_RETENTION_HOURS} hours. Sending requires a secret;
reading does not.</p>

<table>
<thead><tr><th>Method</th><th>Path</th><th>What it does</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>

<footer>
Apache&nbsp;License&nbsp;2.0 · source at <a href="${REPOSITORY}">${REPOSITORY}</a> ·
this page is also available as JSON to any client that does not ask for HTML.
</footer>
</body>
</html>
`;
}

rootRouter.get("/", (c) => {
	const wantsHtml = (c.req.header("Accept") ?? "").includes("text/html");

	if (wantsHtml) {
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
