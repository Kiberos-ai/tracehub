#!/usr/bin/env bun
/**
 * Write a consistent, self-contained copy of the trace database while the
 * service keeps running.
 *
 * Why this exists instead of `cp`: under WAL every trace written since the last
 * checkpoint lives in the -wal file, not in the database file. Copying the
 * database file alone therefore produces a file that opens cleanly, reports no
 * error, and is missing everything recent — measured here as 1000 live traces
 * against a copy that did not even contain the traces table. `VACUUM INTO` asks
 * SQLite itself to write one complete file, so the log is folded in and readers
 * and writers are never blocked.
 *
 *   docker exec tracehub bun run src/tools/snapshot.ts /data/snapshot.db
 *   docker cp tracehub:/data/snapshot.db ./snapshot.db
 *
 * Lives under src/ on purpose: only /opt/tracehub/src is mounted into the
 * container, so a tool kept anywhere else would need an image rebuild to reach
 * the machine that needs it.
 */
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { TRACEHUB_DB } from "../lib/config";

const target = process.argv[2];

if (!target) {
	console.error("usage: bun run src/tools/snapshot.ts <target-file>");
	console.error(`source database: ${TRACEHUB_DB}`);
	process.exit(2);
}

if (existsSync(target)) {
	console.error(`refusing to overwrite an existing file: ${target}`);
	process.exit(2);
}

if (!existsSync(TRACEHUB_DB)) {
	console.error(`no database at ${TRACEHUB_DB}`);
	process.exit(1);
}

const source = new Database(TRACEHUB_DB, { readonly: true });
try {
	source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
	source.close();
}

// Report what the snapshot actually holds, read back from the snapshot itself —
// a count taken from the live database would prove nothing about the copy.
const written = new Database(target, { readonly: true });
let traces = 0;
let correlations = 0;
try {
	traces = (written.query("SELECT count(*) AS c FROM traces").get() as { c: number }).c;
	correlations = (
		written.query("SELECT count(DISTINCT correlation_id) AS c FROM traces").get() as { c: number }
	).c;
} finally {
	written.close();
}

const mb = Math.round((statSync(target).size / 1024 / 1024) * 100) / 100;
console.log(`${target}: ${traces} traces across ${correlations} correlations, ${mb} MB`);
