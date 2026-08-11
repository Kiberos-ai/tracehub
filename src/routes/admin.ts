import { Hono } from "hono";
import { cleanupOldTraces, stats as dbStats, getDbSizeMb } from "../db/operations";
import { TRACEHUB_DB, TRACEHUB_RETENTION_HOURS } from "../lib/config";
import { getWaiterCount } from "../services/long-poll";
import { getSubscriberStats } from "../services/streaming";
import { getSourceIngestTotals, getSourceIngestWindow } from "./ingest";
import { getRecentRateWindow, getRecentRequestsTotal } from "./query";

// =============================================================================
// Server start time
// =============================================================================

const startedAt = Date.now() / 1000;

// =============================================================================
// Router
// =============================================================================

export const adminRouter = new Hono();

adminRouter.get("/stats", (c) => {
	const now = Date.now() / 1000;
	const uptime = now - startedAt;
	const recentRateWindow = getRecentRateWindow();
	const recentRpm = recentRateWindow.filter((t) => now - t < 60).length;
	const sourceIngestWindow = getSourceIngestWindow();
	const sourceIngestTotals = getSourceIngestTotals();

	// DB size
	const dbSizeMb = getDbSizeMb();

	// RSS in MB via process.memoryUsage()
	const rssMb = Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;

	// Top sources by total ingest, show top 5
	const sortedSources = [...sourceIngestTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

	const topSources = sortedSources.map(([sid]) => ({
		source_id: sid,
		rpm: (sourceIngestWindow.get(sid) ?? []).filter((t) => now - t < 60).length,
	}));

	return c.json({
		uptime_seconds: Math.floor(uptime),
		subscribers: getSubscriberStats(),
		long_poll_waiters: getWaiterCount(),
		requests: {
			ingest_total: dbStats.ingestTotal,
			ingest_duplicates: dbStats.ingestDuplicates,
			ingest_deduped: dbStats.ingestDeduped,
			recent_requests_total: getRecentRequestsTotal(),
			recent_rpm: recentRpm,
		},
		database: {
			path: TRACEHUB_DB,
			size_mb: dbSizeMb,
			retention_hours: TRACEHUB_RETENTION_HOURS,
		},
		memory: {
			rss_mb: rssMb,
		},
		top_sources: topSources,
	});
});

adminRouter.get("/stats/sources", (c) => {
	const now = Date.now() / 1000;
	const sourceIngestWindow = getSourceIngestWindow();
	const sourceIngestTotals = getSourceIngestTotals();

	// Merge all known source IDs
	const allSids = new Set([...sourceIngestTotals.keys(), ...sourceIngestWindow.keys()]);

	const sources = [...allSids].sort().map((sid) => {
		const window = sourceIngestWindow.get(sid) ?? [];
		const rpm = window.filter((t) => now - t < 60).length;
		const rp5m = window.length;
		return {
			source_id: sid,
			total: sourceIngestTotals.get(sid) ?? 0,
			rpm,
			rp5m,
		};
	});

	// Sort by rpm descending
	sources.sort((a, b) => b.rpm - a.rpm);

	return c.json({ sources, window_seconds: 300 });
});

adminRouter.delete("/cleanup", (c) => {
	const deleted = cleanupOldTraces();
	return c.json({ deleted });
});
