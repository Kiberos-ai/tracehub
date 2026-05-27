import {
	ADAPTIVE_HOT_TTL,
	ADAPTIVE_WARM_TTL,
	ADAPTIVE_WARM_RATE,
	ADAPTIVE_COLD_RATE,
} from "../lib/config";
import { notifyWaiters } from "./long-poll";

// =============================================================================
// In-memory state
// =============================================================================

interface AdaptiveEntry {
	state: "hot" | "warm";
	expiresAt: number;
	queriedAt: number;
}

const adaptiveState = new Map<string, AdaptiveEntry>();

let configEtag = 0;

// =============================================================================
// State machine functions
// =============================================================================

/**
 * Set or extend HOT state for a correlation ID.
 * Returns previous state: "hot", "warm", or "cold".
 */
export function markHot(corrId: string): string {
	const now = Date.now() / 1000;
	const prev = getState(corrId);
	adaptiveState.set(corrId, {
		state: "hot",
		expiresAt: now + ADAPTIVE_HOT_TTL,
		queriedAt: now,
	});
	configEtag++;
	notifyWaiters();
	return prev;
}

/**
 * Return current state for a correlation ID: "hot", "warm", or "cold".
 */
export function getState(corrId: string): "hot" | "warm" | "cold" {
	const entry = adaptiveState.get(corrId);
	if (!entry) return "cold";
	return entry.state;
}

/**
 * Return sampling rate based on current state.
 */
export function getTraceRate(corrId: string): number {
	const state = getState(corrId);
	if (state === "hot") return 1.0;
	if (state === "warm") return ADAPTIVE_WARM_RATE;
	return ADAPTIVE_COLD_RATE;
}

/**
 * Iterate state map, transition HOT->WARM (expired) and WARM->remove (expired).
 * Called periodically by background task.
 */
export function cooldownTick(): void {
	const now = Date.now() / 1000;
	let changed = false;
	const toRemove: string[] = [];

	for (const [corrId, entry] of adaptiveState) {
		if (entry.expiresAt > now) continue;

		if (entry.state === "hot") {
			entry.state = "warm";
			entry.expiresAt = now + ADAPTIVE_WARM_TTL;
			changed = true;
		} else if (entry.state === "warm") {
			toRemove.push(corrId);
			changed = true;
		}
	}

	for (const corrId of toRemove) {
		adaptiveState.delete(corrId);
	}

	if (changed) {
		configEtag++;
		notifyWaiters();
	}
}

/**
 * Remove a correlation ID from state (set to cold).
 * Returns previous state.
 */
export function removeCorrId(corrId: string): string {
	const prev = getState(corrId);
	if (adaptiveState.has(corrId)) {
		adaptiveState.delete(corrId);
		configEtag++;
		notifyWaiters();
	}
	return prev;
}

/**
 * Return current config etag number.
 */
export function getConfigEtag(): number {
	return configEtag;
}

/**
 * Return adaptive tracing config payload (matches Python /tracing/config response).
 */
export function getConfigPayload(): {
	mode: string;
	default_rate: number;
	warm_rate: number;
	hot_correlations: Record<string, { rate: number; ttl: number }>;
	etag: string;
} {
	const now = Date.now() / 1000;
	const hotCorrelations: Record<string, { rate: number; ttl: number }> = {};

	for (const [corrId, entry] of adaptiveState) {
		if (entry.state === "hot") {
			hotCorrelations[corrId] = {
				rate: 1.0,
				ttl: Math.max(0, Math.round(entry.expiresAt - now)),
			};
		}
	}

	return {
		mode: "adaptive",
		default_rate: ADAPTIVE_COLD_RATE,
		warm_rate: ADAPTIVE_WARM_RATE,
		hot_correlations: hotCorrelations,
		etag: String(configEtag),
	};
}

/**
 * Return all entries with remaining TTL (matches Python /tracing/status response).
 */
export function getStatusPayload(): {
	correlations: Array<{
		correlation_id: string;
		state: string;
		remaining_ttl: number;
		queried_at: number;
	}>;
	count: number;
} {
	const now = Date.now() / 1000;
	const correlations: Array<{
		correlation_id: string;
		state: string;
		remaining_ttl: number;
		queried_at: number;
	}> = [];

	for (const [corrId, entry] of adaptiveState) {
		correlations.push({
			correlation_id: corrId,
			state: entry.state,
			remaining_ttl: Math.max(0, Math.round(entry.expiresAt - now)),
			queried_at: entry.queriedAt,
		});
	}

	return { correlations, count: correlations.length };
}
