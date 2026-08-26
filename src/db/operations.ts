import { statSync } from "node:fs";
import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { TRACEHUB_RETENTION_HOURS } from "../lib/config";
import { TRACEHUB_DB } from "../lib/config";
import type { TraceEntry } from "../lib/types";
import { checkpointTruncate, db, sqlite } from "./client";
import { traces } from "./schema";

// =============================================================================
// Stats tracking
// =============================================================================

export const stats = {
	ingestTotal: 0,
	ingestDuplicates: 0,
	ingestDeduped: 0,
};

// =============================================================================
// Prepared statements (lazy-initialized after initDb)
// =============================================================================

let stmtDedup: ReturnType<typeof sqlite.prepare>;
let stmtInsert: ReturnType<typeof sqlite.prepare>;

// The four seeks behind /correlations. Each resolves through
// idx_created_at_correlation without reading a row — see listRecentCorrelations.
let stmtNewestSecond: ReturnType<typeof sqlite.prepare>;
let stmtSecondBefore: ReturnType<typeof sqlite.prepare>;
let stmtFirstCorrelationIn: ReturnType<typeof sqlite.prepare>;
let stmtNextCorrelationIn: ReturnType<typeof sqlite.prepare>;

// =============================================================================
// Database initialization
// =============================================================================

/**
 * Initialize database — CREATE TABLE IF NOT EXISTS for v1 compatibility
 * with existing Python-created DBs. Does not rely on Drizzle migrations.
 * Also prepares hot-path statements.
 */
export function initDb(): void {
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS traces (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			source_id TEXT NOT NULL,
			correlation_id TEXT NOT NULL,
			timestamp REAL NOT NULL,
			suffix TEXT NOT NULL,
			direction TEXT NOT NULL,
			operation TEXT NOT NULL,
			endpoint TEXT NOT NULL,
			data TEXT,
			hostname TEXT,
			raw_line TEXT,
			created_at REAL DEFAULT (strftime('%s', 'now')),
			UNIQUE(correlation_id, timestamp, suffix)
		)
	`);
	sqlite.exec("CREATE INDEX IF NOT EXISTS idx_correlation_id ON traces(correlation_id)");
	sqlite.exec("CREATE INDEX IF NOT EXISTS idx_timestamp ON traces(timestamp)");
	sqlite.exec("CREATE INDEX IF NOT EXISTS idx_source_id ON traces(source_id)");
	sqlite.exec(
		"CREATE INDEX IF NOT EXISTS idx_dedup ON traces(source_id, correlation_id, endpoint, direction)",
	);
	// Two readers need created_at ordered: the hourly retention DELETE, which
	// without an index reads every row to find the expired ones, and the walk
	// behind /correlations. correlation_id rides along so that walk never has to
	// touch a row at all — see listRecentCorrelations. The single-column index
	// this replaces is dropped, since the composite answers everything it did.
	sqlite.exec(
		"CREATE INDEX IF NOT EXISTS idx_created_at_correlation ON traces(created_at, correlation_id)",
	);
	sqlite.exec("DROP INDEX IF EXISTS idx_created_at");

	// Prepare hot-path statements after table exists
	stmtDedup = sqlite.prepare(`
		UPDATE traces SET timestamp = ?, created_at = ?
		WHERE source_id = ? AND correlation_id = ? AND endpoint = ? AND direction = ?
		AND created_at > ?
	`);
	stmtInsert = sqlite.prepare(`
		INSERT OR IGNORE INTO traces
		(source_id, correlation_id, timestamp, suffix, direction,
		 operation, endpoint, data, hostname, raw_line)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	stmtNewestSecond = sqlite.prepare("SELECT MAX(created_at) AS v FROM traces");
	stmtSecondBefore = sqlite.prepare("SELECT MAX(created_at) AS v FROM traces WHERE created_at < ?");
	stmtFirstCorrelationIn = sqlite.prepare(
		"SELECT MIN(correlation_id) AS v FROM traces WHERE created_at = ?",
	);
	stmtNextCorrelationIn = sqlite.prepare(
		"SELECT MIN(correlation_id) AS v FROM traces WHERE created_at = ? AND correlation_id > ?",
	);
}

// =============================================================================
// Trace operations
// =============================================================================

/**
 * Insert a single trace with dedup logic (CR-05).
 * If same (source_id, correlation_id, endpoint, direction) exists within 5min,
 * UPDATE that row instead of inserting. Otherwise INSERT OR IGNORE.
 * Returns true if a new row was inserted.
 */
export function insertTrace(entry: TraceEntry): boolean {
	const now = Date.now() / 1000;
	stats.ingestTotal++;

	try {
		// Dedup: UPDATE if same key within 5min window
		const updateResult = stmtDedup.run(
			entry.timestamp,
			now,
			entry.source_id,
			entry.correlation_id,
			entry.endpoint,
			entry.direction,
			now - 300, // 5 minute window
		);

		if (updateResult.changes > 0) {
			stats.ingestDeduped++;
			return false;
		}

		// Insert new trace
		const dataJson = entry.data ? JSON.stringify(entry.data) : null;
		const insertResult = stmtInsert.run(
			entry.source_id,
			entry.correlation_id,
			entry.timestamp,
			entry.suffix,
			entry.direction,
			entry.operation,
			entry.endpoint,
			dataJson,
			entry.hostname ?? "unknown",
			entry.raw_line ?? null,
		);

		if (insertResult.changes > 0) {
			return true;
		}

		// INSERT OR IGNORE hit the UNIQUE constraint — duplicate
		stats.ingestDuplicates++;
		return false;
	} catch {
		return false;
	}
}

/**
 * Insert a batch and return the entries that produced a new row.
 *
 * The transaction is the whole point: outside one, SQLite commits — and fsyncs —
 * per statement, which measured at ~18ms per trace, so a 500-trace batch took
 * about 9 seconds. Wrapping the loop makes it one commit for the batch.
 *
 * Callers should notify subscribers from the returned list, after the commit,
 * so nothing is announced that a rollback would have taken back.
 */
export const insertTraces = sqlite.transaction((entries: TraceEntry[]): TraceEntry[] => {
	const insertedEntries: TraceEntry[] = [];
	for (const entry of entries) {
		if (insertTrace(entry)) insertedEntries.push(entry);
	}
	return insertedEntries;
}) as unknown as (entries: TraceEntry[]) => TraceEntry[];

/**
 * Query traces by correlation ID, optionally filtered by source and timestamp.
 */
export function queryTraces(
	correlationId: string,
	sourceId?: string,
	sinceTs?: number,
): Array<typeof traces.$inferSelect> {
	const conditions = [eq(traces.correlationId, correlationId)];

	if (sourceId) {
		conditions.push(eq(traces.sourceId, sourceId));
	}

	if (sinceTs) {
		conditions.push(gt(traces.timestamp, sinceTs));
	}

	return db
		.select()
		.from(traces)
		.where(and(...conditions))
		.orderBy(traces.timestamp)
		.all();
}

/**
 * Count entry/exit directions across a WHOLE correlation.
 *
 * Completeness is a property of the chain, not of the rows a caller happened to
 * ask for: an incremental read (`sinceTs`) must not be able to turn a finished
 * chain into an unfinished-looking one, so this deliberately ignores that filter
 * and aggregates in SQLite rather than materializing the rows.
 */
export function countDirections(
	correlationId: string,
	sourceId?: string,
): { entries: number; exits: number } {
	const rows = db
		.select({ direction: traces.direction, n: sql<number>`count(*)` })
		.from(traces)
		.where(
			sourceId
				? and(eq(traces.correlationId, correlationId), eq(traces.sourceId, sourceId))
				: eq(traces.correlationId, correlationId),
		)
		.groupBy(traces.direction)
		.all();

	let entries = 0;
	let exits = 0;
	for (const row of rows) {
		if (row.direction === "->") entries += row.n;
		if (row.direction === "<-") exits += row.n;
	}
	return { entries, exits };
}

/**
 * List recent correlation IDs with trace counts, timestamps, and sources.
 */
/**
 * List the most recently active correlations, newest first.
 *
 * The obvious statement — GROUP BY the table, ORDER BY MAX(created_at), LIMIT —
 * reads every trace of the whole retention window to hand back fifty rows.
 * Measured on 1,000,000 rows / 200,000 correlations: 116.9 ms, growing linearly
 * with the window. No index removes that, because the cost is the grouping and
 * not the lookup: (correlation_id, created_at) measured 239.8 ms against the
 * plain 235.0 ms, and a fully covering index still 210.2 ms.
 *
 * So the work is made proportional to the ANSWER instead. Every distinct
 * created_at second is reached by one seek, and inside it every distinct
 * correlation by one more — a loose index scan over idx_created_at_correlation,
 * which covers both columns so no row is ever touched. The same fifty rows come
 * back in 0.10 ms, and the shape that breaks naive paging — one loud chain
 * owning the newest 200,000 rows — costs 0.92 ms rather than the 1.8 s a
 * keyset walk over the same data took.
 *
 * Ordering below one second: created_at is second-grained, so chains sharing a
 * second are returned in correlation_id order. Resolving them by true recency
 * would mean reading every row of that second, which is the cost this route
 * exists to avoid. The statement it replaced left such ties to SQLite, so this
 * is a deterministic order where there was an arbitrary one.
 */
export function listRecentCorrelations(limit = 50): Array<{
	correlation_id: string;
	trace_count: number;
	first_ts: number;
	last_ts: number;
	duration_ms: number;
	sources: string[];
}> {
	const ids = recentCorrelationIds(limit);
	if (ids.length === 0) return [];

	const placeholders = ids.map(() => "?").join(",");
	const rows = sqlite
		.prepare(
			`
		SELECT correlation_id,
			   COUNT(*) as trace_count,
			   MIN(timestamp) as first_ts,
			   MAX(timestamp) as last_ts,
			   GROUP_CONCAT(DISTINCT source_id) as sources
		FROM traces
		WHERE correlation_id IN (${placeholders})
		GROUP BY correlation_id
	`,
		)
		.all(...ids) as Array<{
		correlation_id: string;
		trace_count: number;
		first_ts: number;
		last_ts: number;
		sources: string | null;
	}>;

	// The seeks above already produced newest-first order; the aggregate returns
	// them grouped, so restore it rather than sorting again.
	const byId = new Map(rows.map((row) => [row.correlation_id, row]));

	return ids
		.map((id) => byId.get(id))
		.filter((row): row is NonNullable<typeof row> => row !== undefined)
		.map((row) => ({
			correlation_id: row.correlation_id,
			trace_count: row.trace_count,
			first_ts: row.first_ts,
			last_ts: row.last_ts,
			duration_ms: row.last_ts && row.first_ts ? Math.round(row.last_ts - row.first_ts) : 0,
			sources: row.sources ? row.sources.split(",") : [],
		}));
}

/**
 * The `limit` most recently active correlation ids, newest second first.
 *
 * Each statement is one seek into idx_created_at_correlation, so the walk costs
 * a seek per distinct (second, correlation) pair it returns — never a pass over
 * the rows inside them. That is what keeps a chain with 200,000 traces in one
 * second from being read 200,000 times.
 */
function recentCorrelationIds(limit: number): string[] {
	if (limit <= 0) return [];

	const ids: string[] = [];
	const seen = new Set<string>();

	let second = (stmtNewestSecond.get() as { v: number | null } | null)?.v ?? null;

	while (second !== null && ids.length < limit) {
		let corrId = (stmtFirstCorrelationIn.get(second) as { v: string | null } | null)?.v ?? null;

		while (corrId !== null && ids.length < limit) {
			if (!seen.has(corrId)) {
				seen.add(corrId);
				ids.push(corrId);
			}
			corrId =
				(stmtNextCorrelationIn.get(second, corrId) as { v: string | null } | null)?.v ?? null;
		}

		second = (stmtSecondBefore.get(second) as { v: number | null } | null)?.v ?? null;
	}

	return ids;
}

/**
 * Delete traces older than retention period.
 * Returns number of deleted rows.
 */
export function cleanupOldTraces(): number {
	const cutoff = Date.now() / 1000 - TRACEHUB_RETENTION_HOURS * 3600;
	const result = sqlite.prepare("DELETE FROM traces WHERE created_at < ?").run(cutoff);
	if (result.changes > 0) {
		// DELETE only marks pages free — without this the file grows forever
		// under a steady trace load. Incremental keeps the pause short, and the
		// checkpoint is what actually hands the pages back to the filesystem.
		sqlite.exec("PRAGMA incremental_vacuum");
		checkpointTruncate();
	}
	return result.changes;
}

/**
 * Get database file size in MB.
 */
export function getDbSizeMb(): number {
	try {
		const stat = statSync(TRACEHUB_DB);
		return Math.round((stat.size / 1024 / 1024) * 100) / 100;
	} catch {
		return 0;
	}
}
