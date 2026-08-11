// =============================================================================
// @tracehub/sdk — Public API
// =============================================================================

export type { TraceHubConfig, TraceEntry, AdaptiveConfig } from "./types";
export type { LoggerFn, LogEvent } from "./logger";

import { BatchSender } from "./client";
import { ConfigPoller } from "./config-poll";
import { createLogger } from "./logger";
import type { TraceEntry, TraceHubConfig } from "./types";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let poller: ConfigPoller | null = null;
let sender: BatchSender | null = null;
let currentCorrelationId = "";
let hostname = "unknown";
let sourceId = "unknown";

// Detect hostname (works in Node, Bun, Deno; graceful fallback)
try {
	if (typeof globalThis !== "undefined") {
		// Node/Bun: os.hostname()
		// We avoid importing 'os' to stay zero-dep for browser compat.
		// Instead read from env or leave "unknown".
		hostname =
			(globalThis as Record<string, unknown>).process &&
			typeof ((globalThis as Record<string, unknown>).process as Record<string, unknown>).env ===
				"object"
				? ((
						((globalThis as Record<string, unknown>).process as Record<string, unknown>)
							.env as Record<string, string>
					).HOSTNAME ?? "unknown")
				: "unknown";
	}
} catch {
	// Swallow — browser or restricted env
}

// ---------------------------------------------------------------------------
// Suffix counter — auto-incrementing per correlation for ordering
// ---------------------------------------------------------------------------

let suffixCounter = 0;

function nextSuffix(): string {
	suffixCounter += 1;
	return String(suffixCounter).padStart(4, "0");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the SDK. Creates ConfigPoller + BatchSender. (AC-24)
 * Must NOT throw to user code (CN-03).
 */
export function init(config: TraceHubConfig): void {
	try {
		if (!config.url) {
			throw new Error("TraceHubConfig.url is required");
		}

		const url = config.url.replace(/\/+$/, ""); // strip trailing slash
		const logger = createLogger(config.logger);
		const clientId = config.clientId ?? "sdk-default";
		const batchSize = config.batchSize ?? 10;
		const flushInterval = config.flushInterval ?? 1000;
		sourceId = config.sourceId ?? config.projectName ?? "unknown";

		if (config.projectName) {
			sourceId = config.projectName;
		}

		// Create poller (adaptive tracing config)
		const adaptiveEnabled = config.adaptiveTracing !== false; // default: true
		if (adaptiveEnabled) {
			poller = new ConfigPoller(url, clientId, config.secret, logger);
			poller.start();
		}

		// Create batch sender
		sender = new BatchSender(url, config.secret, clientId, batchSize, flushInterval, logger);
	} catch (err) {
		// CN-03: must not throw to user code
		const logger = createLogger(config.logger);
		logger("flush_error", `init failed: ${String(err)}`);
	}
}

/**
 * Record a checkpoint trace. Only sends if shouldTrace returns true for
 * the current correlation ID. (AC-25, CR-06)
 * Must NOT throw to user code (CN-03).
 */
export function checkpoint(
	direction: string,
	operation: string,
	endpoint: string,
	data?: Record<string, unknown>,
): void {
	try {
		if (!sender) return;
		if (!currentCorrelationId) return;

		// Check adaptive tracing decision
		if (poller && !poller.shouldTrace(currentCorrelationId)) {
			return;
		}

		const entry: TraceEntry = {
			source_id: sourceId,
			correlation_id: currentCorrelationId,
			timestamp: Date.now() / 1000, // seconds since epoch
			suffix: nextSuffix(),
			direction,
			operation,
			endpoint,
			hostname,
		};

		if (data !== undefined) {
			entry.data = data;
		}

		sender.send(entry);
	} catch {
		// CN-03: never throw to user code
	}
}

/**
 * Check if a correlation ID should be traced. Delegates to ConfigPoller. (AC-27)
 */
export function shouldTrace(corrId: string): boolean {
	if (!poller) return true; // no adaptive tracing — trace everything
	return poller.shouldTrace(corrId);
}

/**
 * Set the current correlation ID for subsequent checkpoint() calls.
 */
export function setCorrelationId(id: string): void {
	currentCorrelationId = id;
	suffixCounter = 0; // reset suffix counter per correlation
}

/**
 * Get the current correlation ID.
 */
export function getCorrelationId(): string {
	return currentCorrelationId;
}

/**
 * Graceful shutdown: flush remaining traces (5s timeout), stop config poller. (AC-32)
 * Must NOT block indefinitely (CN-02).
 */
export async function close(): Promise<void> {
	try {
		if (sender) {
			await sender.close();
			sender = null;
		}
		if (poller) {
			poller.close();
			poller = null;
		}
	} catch {
		// CN-03: never throw to user code
	}
}
