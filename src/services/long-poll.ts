import { MAX_LONGPOLL_CONNECTIONS } from "../lib/config";

// =============================================================================
// Long-poll waiter management (CR-11)
//
// Two things are waited on here — the sampling config, and the next trace of
// one correlation — so waiters are keyed. The connection budget is deliberately
// shared across every key: it exists to bound sockets held open on this
// process, and a per-key cap would bound nothing.
// =============================================================================

type Reason = "changed" | "timeout";

interface Waiter {
	resolve: (reason: Reason) => void;
}

/** The single key every /tracing/config waiter shares. */
const CONFIG_KEY = "config";

/** Correlation keys are prefixed so no correlation_id can collide with CONFIG_KEY. */
const corrKey = (corrId: string) => `corr:${corrId}`;

const _waiters = new Map<string, Set<Waiter>>();
let _waiterCount = 0;

/**
 * Wait on one key. Resolves "changed" when that key is notified, or "timeout"
 * after waitMs elapses.
 *
 * If MAX_LONGPOLL_CONNECTIONS is reached, resolves "changed" immediately
 * (graceful degradation, CR-11) — the caller then answers from the current
 * state instead of holding another socket.
 */
function addKeyedWaiter(key: string, waitMs: number): Promise<Reason> {
	if (_waiterCount >= MAX_LONGPOLL_CONNECTIONS) {
		return Promise.resolve("changed");
	}

	return new Promise<Reason>((resolve) => {
		let set = _waiters.get(key);
		if (!set) {
			set = new Set();
			_waiters.set(key, set);
		}

		const waiter: Waiter = { resolve };
		set.add(waiter);
		_waiterCount++;

		const drop = () => {
			const current = _waiters.get(key);
			if (current?.delete(waiter)) {
				_waiterCount--;
				if (current.size === 0) _waiters.delete(key);
			}
		};

		const timer = setTimeout(() => {
			drop();
			resolve("timeout");
		}, waitMs);

		waiter.resolve = (reason: Reason) => {
			clearTimeout(timer);
			drop();
			resolve(reason);
		};
	});
}

function notifyKey(key: string): void {
	const set = _waiters.get(key);
	if (!set) return;
	// Copy first: each resolve mutates the set it is iterating.
	for (const waiter of [...set]) {
		waiter.resolve("changed");
	}
}

/** Wait for the sampling config to change. */
export function addWaiter(waitMs: number): Promise<Reason> {
	return addKeyedWaiter(CONFIG_KEY, waitMs);
}

/** Notify config waiters. Called from adaptive.ts when the etag increments. */
export function notifyWaiters(): void {
	notifyKey(CONFIG_KEY);
}

/** Wait for the next trace of one correlation to be stored. */
export function addCorrelationWaiter(corrId: string, waitMs: number): Promise<Reason> {
	return addKeyedWaiter(corrKey(corrId), waitMs);
}

/** Notify readers waiting on one correlation. Called after the ingest commit. */
export function notifyCorrelation(corrId: string): void {
	notifyKey(corrKey(corrId));
}

/**
 * Return current count of waiting connections, across every key. Used by /stats.
 */
export function getWaiterCount(): number {
	return _waiterCount;
}
