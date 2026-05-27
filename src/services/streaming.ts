import type { TraceEntry } from "../lib/types";

// =============================================================================
// SSE subscriber management — port of Python streaming.py
// =============================================================================

interface Subscriber {
	writer: WritableStreamDefaultWriter;
	addedAt: number;
}

/** corrId -> set of subscriber writers */
const _subscribers = new Map<string, Set<Subscriber>>();

/** corrId -> last activity timestamp (for stale cleanup) */
const _subscriberTimestamps = new Map<string, number>();

/**
 * Subscribe to real-time trace updates for a correlation ID.
 * Returns a Subscriber handle for cleanup.
 */
export function subscribe(
	corrId: string,
	writer: WritableStreamDefaultWriter,
): Subscriber {
	if (!_subscribers.has(corrId)) {
		_subscribers.set(corrId, new Set());
	}
	const sub: Subscriber = { writer, addedAt: Date.now() };
	_subscribers.get(corrId)!.add(sub);
	_subscriberTimestamps.set(corrId, Date.now());
	return sub;
}

/**
 * Unsubscribe a specific writer from a correlation ID.
 */
export function unsubscribe(corrId: string, sub: Subscriber): void {
	const subs = _subscribers.get(corrId);
	if (!subs) return;
	subs.delete(sub);
	if (subs.size === 0) {
		_subscribers.delete(corrId);
		_subscriberTimestamps.delete(corrId);
	}
}

/**
 * Notify all subscribers for a trace's correlation ID.
 * Dead writers are removed automatically.
 */
export function notifySubscribers(trace: TraceEntry): void {
	const corrId = trace.correlation_id;
	const subs = _subscribers.get(corrId);
	if (!subs || subs.size === 0) return;

	const data = `data: ${JSON.stringify(trace)}\n\n`;
	const encoder = new TextEncoder();
	const encoded = encoder.encode(data);
	const deadSubs: Subscriber[] = [];

	for (const sub of subs) {
		try {
			sub.writer.write(encoded).catch(() => {
				deadSubs.push(sub);
			});
		} catch {
			deadSubs.push(sub);
		}
	}

	for (const dead of deadSubs) {
		subs.delete(dead);
	}

	if (subs.size === 0) {
		_subscribers.delete(corrId);
		_subscriberTimestamps.delete(corrId);
	}

	_subscriberTimestamps.set(corrId, Date.now());
}

/**
 * Remove subscriber entries older than 5 minutes with no recent activity.
 */
export function cleanupStaleSubscribers(): void {
	const cutoff = Date.now() - 300_000; // 5 min
	const stale: string[] = [];

	for (const [corrId, ts] of _subscriberTimestamps) {
		if (ts < cutoff) {
			stale.push(corrId);
		}
	}

	for (const corrId of stale) {
		const subs = _subscribers.get(corrId);
		if (subs) {
			for (const sub of subs) {
				try {
					sub.writer.close();
				} catch {
					// already closed
				}
			}
		}
		_subscribers.delete(corrId);
		_subscriberTimestamps.delete(corrId);
	}
}

/**
 * Return subscriber statistics for /stats endpoint.
 */
export function getSubscriberStats(): {
	activeCorrelations: number;
	totalQueues: number;
} {
	let totalQueues = 0;
	for (const subs of _subscribers.values()) {
		totalQueues += subs.size;
	}
	return {
		activeCorrelations: _subscribers.size,
		totalQueues,
	};
}
