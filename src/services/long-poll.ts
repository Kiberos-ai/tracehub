import { MAX_LONGPOLL_CONNECTIONS } from "../lib/config";

// =============================================================================
// Long-poll waiter management (CR-11)
// =============================================================================

interface Waiter {
	resolve: (reason: "changed" | "timeout") => void;
}

const _waiters = new Set<Waiter>();

/**
 * Add a long-poll waiter. Returns "changed" when config etag changes,
 * or "timeout" after waitMs elapses.
 *
 * If MAX_LONGPOLL_CONNECTIONS reached, returns "changed" immediately
 * (graceful degradation, CR-11).
 */
export function addWaiter(waitMs: number): Promise<"changed" | "timeout"> {
	if (_waiters.size >= MAX_LONGPOLL_CONNECTIONS) {
		return Promise.resolve("changed");
	}

	return new Promise<"changed" | "timeout">((resolve) => {
		const waiter: Waiter = { resolve };
		_waiters.add(waiter);

		const timer = setTimeout(() => {
			_waiters.delete(waiter);
			resolve("timeout");
		}, waitMs);

		// Override resolve to also clear the timer
		waiter.resolve = (reason: "changed" | "timeout") => {
			clearTimeout(timer);
			_waiters.delete(waiter);
			resolve(reason);
		};
	});
}

/**
 * Notify all waiting long-poll connections that config has changed.
 * Called from adaptive.ts when etag increments.
 */
export function notifyWaiters(): void {
	for (const waiter of _waiters) {
		waiter.resolve("changed");
	}
	// Set is cleaned up inside each waiter.resolve
}

/**
 * Return current count of waiting connections. Used by /stats.
 */
export function getWaiterCount(): number {
	return _waiters.size;
}
