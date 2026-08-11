import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { TRACEHUB_DB } from "../lib/config";
import * as schema from "./schema";

// Ensure data directory exists
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
mkdirSync(dirname(TRACEHUB_DB), { recursive: true });

/** Raw bun:sqlite connection */
const sqlite = new Database(TRACEHUB_DB);

// CR-09: WAL mode for concurrent read/write
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("PRAGMA busy_timeout = 5000");

// Retention cleanup DELETEs rows hourly; SQLite keeps those pages in the file
// unless auto_vacuum is on. The mode can only be changed on an empty database
// or through a full VACUUM, so an existing NONE database is converted once at
// startup — after that cleanupOldTraces() reclaims space incrementally.
const autoVacuumMode =
	(sqlite.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number } | null)?.auto_vacuum ?? 0;

if (autoVacuumMode !== 2 /* INCREMENTAL */) {
	sqlite.exec("PRAGMA auto_vacuum = INCREMENTAL");
	sqlite.exec("VACUUM");
	console.error("[TracHub] DB converted to auto_vacuum=INCREMENTAL (one-time VACUUM)");
}

// Reclaim on every start, not only on conversion: a database converted by an
// earlier build still carries its historical file size until something
// checkpoints it, and a restart is the one moment with no readers to block.
{
	const sizeBefore = dbFileSizeMb();
	checkpointTruncate();
	sqlite.exec("PRAGMA incremental_vacuum");
	checkpointTruncate();
	const sizeAfter = dbFileSizeMb();
	if (sizeBefore - sizeAfter >= 1) {
		console.error(`[TracHub] Reclaimed ${Math.round(sizeBefore - sizeAfter)} MB of free pages`);
	}
}

function dbFileSizeMb(): number {
	try {
		return statSync(TRACEHUB_DB).size / 1024 / 1024;
	} catch {
		return 0;
	}
}

/**
 * Truncate the WAL so freed pages actually leave the main database file.
 * Under WAL a VACUUM rebuilds the database but the file itself only shrinks at
 * checkpoint time — without this the file stays at its historical peak size.
 * Best-effort: a busy checkpoint is retried by the next cleanup cycle.
 */
export function checkpointTruncate(): void {
	try {
		sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch (e) {
		console.error(`[TracHub] WAL checkpoint skipped: ${e instanceof Error ? e.message : e}`);
	}
}

/** Drizzle ORM instance (sync API via bun:sqlite) */
export const db = drizzle(sqlite, { schema });

/** Raw sqlite handle for prepared statements / raw SQL */
export { sqlite };
