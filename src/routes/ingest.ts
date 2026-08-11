import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { stats as dbStats, insertTrace } from "../db/operations";
import { TraceEntrySchema, TraceIngestRequestSchema } from "../lib/types";
import type { TraceEntry } from "../lib/types";
import { authMiddleware } from "../middleware/auth";
import { notifySubscribers } from "../services/streaming";

// =============================================================================
// In-memory state for ingest tracking
// =============================================================================

const sourceIngestWindow: Map<string, number[]> = new Map();
const sourceIngestTotals: Map<string, number> = new Map();

/** Exported for stats routes */
export function getSourceIngestWindow(): Map<string, number[]> {
	return sourceIngestWindow;
}

/** Exported for stats routes */
export function getSourceIngestTotals(): Map<string, number> {
	return sourceIngestTotals;
}

// =============================================================================
// SSE notification — wired to streaming service
// =============================================================================

/** Callback invoked when a new trace is inserted. Notifies SSE subscribers. */
const onTraceInserted: (trace: TraceEntry) => void = notifySubscribers;

// =============================================================================
// Router
// =============================================================================

export const ingestRouter = new Hono();

// Auth middleware scoped to /ingest paths only
ingestRouter.use("/ingest/*", authMiddleware);
ingestRouter.use("/ingest", authMiddleware);

ingestRouter.post("/ingest", zValidator("json", TraceIngestRequestSchema), (c) => {
	const body = c.req.valid("json");
	let inserted = 0;
	const now = Date.now() / 1000;

	for (const trace of body.traces) {
		if (insertTrace(trace)) {
			inserted++;
			if (onTraceInserted) onTraceInserted(trace);
		}
		// Track per-source rates
		const sid = trace.source_id;
		if (!sourceIngestWindow.has(sid)) {
			sourceIngestWindow.set(sid, []);
		}
		sourceIngestWindow.get(sid)!.push(now);
		sourceIngestTotals.set(sid, (sourceIngestTotals.get(sid) ?? 0) + 1);
	}

	dbStats.ingestTotal += inserted;
	dbStats.ingestDuplicates += body.traces.length - inserted;

	return c.json({
		accepted: body.traces.length,
		inserted,
		duplicates: body.traces.length - inserted,
	});
});

ingestRouter.post("/ingest/single", zValidator("json", TraceEntrySchema), (c) => {
	const trace = c.req.valid("json");
	const now = Date.now() / 1000;
	const inserted = insertTrace(trace);
	if (inserted && onTraceInserted) {
		onTraceInserted(trace);
	}
	const sid = trace.source_id;
	if (!sourceIngestWindow.has(sid)) {
		sourceIngestWindow.set(sid, []);
	}
	sourceIngestWindow.get(sid)!.push(now);
	sourceIngestTotals.set(sid, (sourceIngestTotals.get(sid) ?? 0) + 1);
	return c.json({ inserted });
});
