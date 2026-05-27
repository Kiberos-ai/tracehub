import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { TRACEHUB_DB } from "../lib/config";
import * as schema from "./schema";

// Ensure data directory exists
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
mkdirSync(dirname(TRACEHUB_DB), { recursive: true });

/** Raw bun:sqlite connection */
const sqlite = new Database(TRACEHUB_DB);

// CR-09: WAL mode for concurrent read/write
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("PRAGMA busy_timeout = 5000");

/** Drizzle ORM instance (sync API via bun:sqlite) */
export const db = drizzle(sqlite, { schema });

/** Raw sqlite handle for prepared statements / raw SQL */
export { sqlite };
