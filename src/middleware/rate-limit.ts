import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import {
	TRACEHUB_BAN_HARD,
	TRACEHUB_BAN_WARNING,
	TRACEHUB_RATE_CONFIG,
	TRACEHUB_RATE_INGEST,
	TRACEHUB_RATE_QUERY,
} from "../lib/config";

// =============================================================================
// Three-tier abuse protection (CR-02, DB-09)
// =============================================================================

interface ClientState {
	windows: Map<string, number[]>; // endpoint_group -> timestamps
	violations: number;
	violationWindowStart: number;
	banUntil: number | null;
	banTier: 0 | 1 | 2;
	warningBanCount: number;
	lastWarningBanAt: number;
}

const clients = new Map<string, ClientState>();

/** Per-IP coarse rate limit: 1000 req/min */
const ipWindows = new Map<string, number[]>();

/** Rate limits per endpoint group */
const groupLimits: Record<string, number> = {
	ingest: TRACEHUB_RATE_INGEST,
	config: TRACEHUB_RATE_CONFIG,
	query: TRACEHUB_RATE_QUERY,
};

/**
 * Determine endpoint group from request path.
 */
function getEndpointGroup(path: string): string {
	if (path.startsWith("/ingest")) return "ingest";
	if (path.startsWith("/tracing/config")) return "config";
	if (path.startsWith("/traces") || path.startsWith("/recent") || path.startsWith("/correlations"))
		return "query";
	return "other";
}

/**
 * Get or create client state.
 */
function getClientState(clientId: string): ClientState {
	let state = clients.get(clientId);
	if (!state) {
		state = {
			windows: new Map(),
			violations: 0,
			violationWindowStart: Date.now(),
			banUntil: null,
			banTier: 0,
			warningBanCount: 0,
			lastWarningBanAt: 0,
		};
		clients.set(clientId, state);
	}
	return state;
}

/**
 * Rate limit middleware. Mount on all routes.
 * Reads clientId from c.get("clientId") (set by client-id middleware).
 */
export const rateLimitMiddleware = createMiddleware(async (c: Context, next: Next) => {
	const clientId = (c.get("clientId") as string) ?? "unknown";
	const now = Date.now();
	const state = getClientState(clientId);

	// --- Tier check: is client banned? ---
	if (state.banUntil && state.banUntil > now) {
		const remainingSec = Math.ceil((state.banUntil - now) / 1000);
		c.header("Retry-After", String(remainingSec));
		return c.json(
			{
				error: "temporary_ban",
				message:
					"Client temporarily banned: sustained rate limit violations. Check SDK configuration.",
				ban_seconds: remainingSec,
				retry_after: remainingSec,
				client_id: clientId,
				violations: state.violations,
				hint: "If using @tracehub/sdk, ensure batch_size >= 10",
			},
			429,
		);
	}

	// --- Per-IP coarse limit (1000 req/min) ---
	const ip = c.req.header("x-forwarded-for") ?? "unknown";
	let ipWindow = ipWindows.get(ip);
	if (!ipWindow) {
		ipWindow = [];
		ipWindows.set(ip, ipWindow);
	}
	// Trim entries older than 60s
	const ipCutoff = now - 60_000;
	while (ipWindow.length > 0 && ipWindow[0] < ipCutoff) {
		ipWindow.shift();
	}
	if (ipWindow.length >= 1000) {
		c.header("Retry-After", "5");
		return c.json(
			{
				error: "rate_limit_exceeded",
				message: "IP rate limit exceeded",
				retry_after: 5,
			},
			429,
		);
	}
	ipWindow.push(now);

	// --- Per-client per-group sliding window ---
	const group = getEndpointGroup(c.req.path);
	const limit = groupLimits[group];

	// "other" group (health, stats) — no per-group limit
	if (limit !== undefined) {
		let window = state.windows.get(group);
		if (!window) {
			window = [];
			state.windows.set(group, window);
		}
		const cutoff = now - 60_000;
		while (window.length > 0 && window[0] < cutoff) {
			window.shift();
		}

		if (window.length >= limit) {
			// Rate limit hit — increment violations
			state.violations++;

			// Reset violation window if >2min elapsed
			if (now - state.violationWindowStart > 120_000) {
				state.violations = 1;
				state.violationWindowStart = now;
			}

			// Check escalation: 10 violations in 2min -> warning ban
			if (state.violations >= 10 && state.banTier < 1) {
				state.banTier = 1;
				state.banUntil = now + TRACEHUB_BAN_WARNING * 1000;
				state.warningBanCount++;
				state.lastWarningBanAt = now;
				console.error(`[TracHub] Client ${clientId} banned (tier 1) for ${TRACEHUB_BAN_WARNING}s`);
			}

			// Check escalation: 3 warning bans in 1 hour -> hard ban
			if (state.warningBanCount >= 3 && now - state.lastWarningBanAt < 3_600_000) {
				state.banTier = 2;
				state.banUntil = now + TRACEHUB_BAN_HARD * 1000;
				console.error(`[TracHub] Client ${clientId} banned (tier 2) for ${TRACEHUB_BAN_HARD}s`);
			}

			c.header("Retry-After", "5");
			return c.json(
				{
					error: "rate_limit_exceeded",
					message: `Rate limit exceeded for ${group} endpoint`,
					retry_after: 5,
				},
				429,
			);
		}

		window.push(now);
	}

	await next();
});

/**
 * Cleanup stale rate limit state. Call every 60s from lifecycle loop.
 * Removes entries inactive >10min, resets hourly violation counters.
 */
export function cleanupRateLimitState(): void {
	const now = Date.now();
	const inactiveCutoff = now - 600_000; // 10 min

	for (const [clientId, state] of clients) {
		// Check if all windows are empty / stale
		let lastActivity = 0;
		for (const timestamps of state.windows.values()) {
			if (timestamps.length > 0) {
				lastActivity = Math.max(lastActivity, timestamps[timestamps.length - 1]);
			}
		}

		if (lastActivity < inactiveCutoff && (!state.banUntil || state.banUntil < now)) {
			clients.delete(clientId);
			continue;
		}

		// Reset hourly violation counters
		if (now - state.violationWindowStart > 3_600_000) {
			state.violations = 0;
			state.violationWindowStart = now;
			state.warningBanCount = 0;
		}
	}

	// Cleanup IP windows
	const ipCutoff = now - 600_000;
	for (const [ip, timestamps] of ipWindows) {
		if (timestamps.length === 0 || timestamps[timestamps.length - 1] < ipCutoff) {
			ipWindows.delete(ip);
		}
	}
}
