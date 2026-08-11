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
 * List recent correlation IDs with trace counts, timestamps, and sources.
 */
export function listRecentCorrelations(limit = 50): Array<{
	correlation_id: string;
	trace_count: number;
	first_ts: number;
	last_ts: number;
	duration_ms: number;
	sources: string[];
}> {
	const rows = sqlite
		.prepare(
			`
		SELECT correlation_id,
			   COUNT(*) as trace_count,
			   MIN(timestamp) as first_ts,
			   MAX(timestamp) as last_ts,
			   GROUP_CONCAT(DISTINCT source_id) as sources
		FROM traces
		GROUP BY correlation_id
		ORDER BY MAX(created_at) DESC
		LIMIT ?
	`,
		)
		.all(limit) as Array<{
		correlation_id: string;
		trace_count: number;
		first_ts: number;
		last_ts: number;
		sources: string | null;
	}>;

	return rows.map((row) => ({
		correlation_id: row.correlation_id,
		trace_count: row.trace_count,
		first_ts: row.first_ts,
		last_ts: row.last_ts,
		duration_ms: row.last_ts && row.first_ts ? Math.round(row.last_ts - row.first_ts) : 0,
		sources: row.sources ? row.sources.split(",") : [],
	}));
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
