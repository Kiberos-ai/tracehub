import { Hono } from "hono";
import { sqlite } from "../db/client";
import { listRecentCorrelations, queryTraces } from "../db/operations";
import { ADAPTIVE_HOT_TTL } from "../lib/config";
import { getState, markHot } from "../services/adaptive";
import { subscribe, unsubscribe } from "../services/streaming";

// =============================================================================
// In-memory state for /recent rate limiting
// =============================================================================

const recentRateWindow: number[] = [];
let recentRequestsTotal = 0;

/** Exported for stats routes */
export function getRecentRateWindow(): number[] {
	return recentRateWindow;
}

/** Exported for stats routes */
export function getRecentRequestsTotal(): number {
	return recentRequestsTotal;
}

// =============================================================================
// Router
// =============================================================================

export const queryRouter = new Hono();

queryRouter.get("/traces/:correlationId", (c) => {
	const correlationId = c.req.param("correlationId");
	const source = c.req.query("source") ?? undefined;

	// Auto-HOT: get previous state, then mark hot
	const previousState = getState(correlationId);
	markHot(correlationId);

	const rows = queryTraces(correlationId, source);

	// Compute completeness: matching entry/exit pairs
	let entries = 0;
	let exits = 0;
	for (const t of rows) {
		if (t.direction === "->") entries++;
		if (t.direction === "<-") exits++;
	}
	const complete = entries > 0 && entries === exits;

	// Map DB rows to JSON response matching Python output exactly
	const traces = rows.map((r) => ({
		source_id: r.sourceId,
		correlation_id: r.correlationId,
		timestamp: r.timestamp,
		suffix: r.suffix,
		direction: r.direction,
		operation: r.operation,
		endpoint: r.endpoint,
		data: r.data ? JSON.parse(r.data) : null,
		hostname: r.hostname,
		raw_line: r.rawLine,
	}));

	const responseData: Record<string, unknown> = {
		correlation_id: correlationId,
		traces,
		count: traces.length,
		complete,
	};

	// Adaptive hint when transitioning from cold
	if (previousState === "cold") {
		responseData.adaptive_hint = {
			previous_state: "cold",
			current_state: "hot",
			message:
				"Tracing activated. Previous traces may be incomplete (COLD mode). Full recording started.",
			retry_after_seconds: 45,
		};
	}

	return c.json(responseData);
});

queryRouter.get("/recent", (c) => {
	const now = Date.now() / 1000;

	// Rate limiting: track timestamp
	recentRateWindow.push(now);
	recentRequestsTotal++;

	// Count requests in last 60 seconds
	const recentCount = recentRateWindow.filter((t) => now - t < 60).length;
	if (recentCount > 30) {
		return c.json({ detail: "Rate limit exceeded: max 30 requests/minute" }, 429);
	}

	// Parse query params
	const limitParam = Number(c.req.query("limit") ?? "200");
	const limit = Math.min(Math.max(1, limitParam), 1000);
	const sinceIdParam = c.req.query("since_id");
	const sinceId = sinceIdParam ? Number(sinceIdParam) : null;
	const source = c.req.query("source") ?? null;

	// Build raw SQL query matching Python behavior
	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (sinceId !== null) {
		conditions.push("id > ?");
		params.push(sinceId);
	}
	if (source) {
		conditions.push("source_id LIKE ?");
		params.push(`${source}%`);
	}
	// Exclude catch-all correlation
	conditions.push("correlation_id != '-'");

	let query = "SELECT * FROM traces";
	if (conditions.length > 0) {
		query += ` WHERE ${conditions.join(" AND ")}`;
	}
	query += " ORDER BY id DESC LIMIT ?";
	params.push(limit);

	const rows = sqlite.prepare(query).all(...params) as Array<{
		id: number;
		source_id: string;
		correlation_id: string;
		timestamp: number;
		direction: string;
		operation: string;
		endpoint: string;
		data: string | null;
	}>;

	const traces = rows.map((row) => ({
		id: row.id,
		source_id: row.source_id,
		correlation_id: row.correlation_id,
		timestamp: row.timestamp,
		direction: row.direction,
		operation: row.operation,
		endpoint: row.endpoint,
		data: row.data ? JSON.parse(row.data) : null,
	}));

	// Reverse to oldest-first (matching Python behavior)
	traces.reverse();

	return c.json({ traces, count: traces.length });
});

queryRouter.get("/traces/:correlationId/stream", (c) => {
	const correlationId = c.req.param("correlationId");
	const timeoutSec = Math.min(Number(c.req.query("timeout") ?? "60"), 300);
	const timeoutMs = timeoutSec * 1000;
	const encoder = new TextEncoder();

	// Auto-HOT the correlation
	markHot(correlationId);

	// Fetch existing traces to send first
	const existingRows = queryTraces(correlationId);
	const existingTraces = existingRows.map((r) => ({
		source_id: r.sourceId,
		correlation_id: r.correlationId,
		timestamp: r.timestamp,
		suffix: r.suffix,
		direction: r.direction,
		operation: r.operation,
		endpoint: r.endpoint,
		data: r.data ? JSON.parse(r.data) : null,
		hostname: r.hostname,
		raw_line: r.rawLine,
	}));

	// Create a TransformStream — the streaming service writes to the writer,
	// the readable side becomes the SSE response body
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const sub = subscribe(correlationId, writer);

	let closed = false;
	const cleanup = () => {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		clearTimeout(timeout);
		unsubscribe(correlationId, sub);
		try {
			writer.close();
		} catch {
			// already closed
		}
	};

	// Send existing traces immediately
	(async () => {
		try {
			for (const trace of existingTraces) {
				await writer.write(encoder.encode(`data: ${JSON.stringify(trace)}\n\n`));
			}
		} catch {
			cleanup();
		}
	})();

	// Heartbeat every 15s
	const heartbeat = setInterval(() => {
		writer.write(encoder.encode(": ping\n\n")).catch(() => cleanup());
	}, 15_000);

	// Timeout: send final event and close
	const timeout = setTimeout(() => {
		writer
			.write(encoder.encode(`data: ${JSON.stringify({ type: "timeout" })}\n\n`))
			.catch(() => {})
			.finally(() => cleanup());
	}, timeoutMs);

	// Abort handler (client disconnect)
	c.req.raw.signal?.addEventListener("abort", cleanup);

	return new Response(readable, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
});

queryRouter.get("/correlations", (c) => {
	const limitParam = Number(c.req.query("limit") ?? "50");
	const limit = Math.min(Math.max(1, limitParam), 1000);
	const correlations = listRecentCorrelations(limit);
	return c.json({ correlations, count: correlations.length });
});
