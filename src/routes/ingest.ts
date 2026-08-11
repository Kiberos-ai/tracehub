import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { insertTrace, insertTraces } from "../db/operations";
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

/**
 * Record one ingest against its source, for /stats/sources.
 * Shared by both ingest routes — /ingest/single used to skip this, so sources
 * that only ever sent single traces never showed up in the per-source stats.
 */
function trackSourceIngest(sourceId: string, now: number): void {
	let window = sourceIngestWindow.get(sourceId);
	if (!window) {
		window = [];
		sourceIngestWindow.set(sourceId, window);
	}
	window.push(now);
	sourceIngestTotals.set(sourceId, (sourceIngestTotals.get(sourceId) ?? 0) + 1);
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
	const now = Date.now() / 1000;

	// One transaction for the whole batch — per-statement commits cost a fsync each.
	const insertedEntries = insertTraces(body.traces);

	// Announce only after the commit, and count sources for every trace received.
	for (const trace of insertedEntries) {
		if (onTraceInserted) onTraceInserted(trace);
	}
	for (const trace of body.traces) {
		trackSourceIngest(trace.source_id, now);
	}

	// Counters are owned by insertTrace(), which alone can tell a UNIQUE-constraint
	// duplicate from a 5-minute-window dedup. Adding to them here double-counted
	// every batched trace and filed both kinds under "duplicates".

	const inserted = insertedEntries.length;
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
	trackSourceIngest(trace.source_id, now);
	return c.json({ inserted });
});
