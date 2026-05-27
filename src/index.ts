import { app } from "./app";
import {
	TRACEHUB_PORT,
	TRACEHUB_DB,
	TRACEHUB_SECRET,
	TRACEHUB_RETENTION_HOURS,
	ADAPTIVE_TICK_INTERVAL,
	MAX_LONGPOLL_CONNECTIONS,
} from "./lib/config";
import { initDb, cleanupOldTraces } from "./db/operations";
import { cooldownTick } from "./services/adaptive";
import { cleanupStaleSubscribers } from "./services/streaming";
import { cleanupRateLimitState } from "./middleware/rate-limit";
import { getSourceIngestWindow } from "./routes/ingest";
import { getRecentRateWindow } from "./routes/query";

// =============================================================================
// Database initialization
// =============================================================================

initDb();

// =============================================================================
// Startup banner (NFR-11: stderr)
// =============================================================================

console.error(`[TracHub] v1.0.0 — https://muid.io`);
console.error(`[TracHub] Port: ${TRACEHUB_PORT}`);
console.error(`[TracHub] DB: ${TRACEHUB_DB} (WAL mode)`);
console.error(`[TracHub] Retention: ${TRACEHUB_RETENTION_HOURS} hours`);
console.error(
	`[TracHub] Secret: ${TRACEHUB_SECRET ? "configured" : "not configured"}`,
);
console.error(`[TracHub] Max long-poll: ${MAX_LONGPOLL_CONNECTIONS}`);

// =============================================================================
// Background cleanup loop
// =============================================================================

let tick = 0;

const tickIntervalMs = ADAPTIVE_TICK_INTERVAL * 1000;

const cleanupInterval = setInterval(() => {
	tick++;

	// Every tick (10s): adaptive cooldown
	cooldownTick();

	// Every ~60s (tick % 6 === 0): stale subscriber + rate limit cleanup
	if (tick % 6 === 0) {
		cleanupStaleSubscribers();
		cleanupRateLimitState();

		// Trim sliding windows in ingest/query routes (keep last 5 min)
		const cutoff = Date.now() / 1000 - 300;
		for (const timestamps of getSourceIngestWindow().values()) {
			while (timestamps.length > 0 && timestamps[0] < cutoff) {
				timestamps.shift();
			}
		}
		const recentWindow = getRecentRateWindow();
		while (recentWindow.length > 0 && recentWindow[0] < cutoff) {
			recentWindow.shift();
		}
	}

	// Every ~1h (tick % 360 === 0): old trace cleanup
	if (tick % 360 === 0) {
		const deleted = cleanupOldTraces();
		if (deleted > 0) {
			console.error(`[TracHub] Cleaned up ${deleted} old traces`);
		}
	}
}, tickIntervalMs);

// =============================================================================
// HTTP server
// =============================================================================

const server = Bun.serve({
	fetch: app.fetch,
	port: TRACEHUB_PORT,
});

console.error(`[TracHub] Listening on 0.0.0.0:${server.port}`);

// =============================================================================
// Graceful shutdown
// =============================================================================

function shutdown() {
	console.error("[TracHub] Shutting down...");
	clearInterval(cleanupInterval);
	server.stop();
	process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
