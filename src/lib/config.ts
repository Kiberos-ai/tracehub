// =============================================================================
// Configuration — all env vars with typed defaults
// =============================================================================

/** SQLite database path (CR-10: NOT /tmp/) */
export const TRACEHUB_DB = process.env.TRACEHUB_DB ?? "./data/tracehub.db";

/** HTTP server port */
export const TRACEHUB_PORT = Number(process.env.TRACEHUB_PORT ?? "8099");

/** Shared secret for ingest auth (empty = no auth required) */
export const TRACEHUB_SECRET = process.env.TRACEHUB_SECRET ?? "";

/** Trace retention period in hours */
export const TRACEHUB_RETENTION_HOURS = Number(process.env.TRACEHUB_RETENTION_HOURS ?? "24");

// Adaptive tracing timers (DB-08)
/** HOT state TTL in seconds */
export const ADAPTIVE_HOT_TTL = Number(process.env.ADAPTIVE_HOT_TTL ?? "300");

/** WARM state TTL in seconds */
export const ADAPTIVE_WARM_TTL = Number(process.env.ADAPTIVE_WARM_TTL ?? "1500");

/** WARM sampling rate (0.0 - 1.0) */
export const ADAPTIVE_WARM_RATE = Number(process.env.ADAPTIVE_WARM_RATE ?? "0.1");

/** COLD sampling rate (0.0 = no tracing) */
export const ADAPTIVE_COLD_RATE = Number(process.env.ADAPTIVE_COLD_RATE ?? "0.0");

/** Cooldown tick interval in seconds */
export const ADAPTIVE_TICK_INTERVAL = Number(process.env.ADAPTIVE_TICK_INTERVAL ?? "10");

// Long-poll (CR-11)
/** Maximum concurrent long-poll connections */
export const MAX_LONGPOLL_CONNECTIONS = Number(process.env.MAX_LONGPOLL_CONNECTIONS ?? "200");

// Rate limiting
/** Ingest requests per minute per client */
export const TRACEHUB_RATE_INGEST = Number(process.env.TRACEHUB_RATE_INGEST ?? "120");

/** Config requests per minute per client */
export const TRACEHUB_RATE_CONFIG = Number(process.env.TRACEHUB_RATE_CONFIG ?? "10");

/** Query requests per minute per client */
export const TRACEHUB_RATE_QUERY = Number(process.env.TRACEHUB_RATE_QUERY ?? "60");

// Ban durations (DB-09)
/** Warning ban duration in seconds */
export const TRACEHUB_BAN_WARNING = Number(process.env.TRACEHUB_BAN_WARNING ?? "60");

/** Hard ban duration in seconds */
export const TRACEHUB_BAN_HARD = Number(process.env.TRACEHUB_BAN_HARD ?? "300");
