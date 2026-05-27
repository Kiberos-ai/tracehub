// =============================================================================
// BatchSender — queues traces and sends in batches to /ingest (CR-07)
// =============================================================================

import type { TraceEntry } from "./types";
import type { LoggerFn } from "./logger";

const MAX_QUEUE_SIZE = 10_000; // AC-30: drop oldest if exceeded

export class BatchSender {
	private url: string;
	private secret: string | undefined;
	private clientId: string;
	private batchSize: number;
	private flushInterval: number;
	private logger: LoggerFn;

	private queue: TraceEntry[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private paused = false;
	private pauseUntil = 0;
	private backoffMs = 1000;
	private readonly maxBackoffMs = 5 * 60 * 1000; // 5 min cap

	constructor(
		url: string,
		secret: string | undefined,
		clientId: string,
		batchSize: number,
		flushInterval: number,
		logger: LoggerFn,
	) {
		this.url = url;
		this.secret = secret;
		this.clientId = clientId;
		this.batchSize = batchSize;
		this.flushInterval = flushInterval;
		this.logger = logger;

		this.timer = setInterval(() => {
			this._flush();
		}, this.flushInterval);
	}

	/** Enqueue a trace entry. Auto-flushes when batch size reached. */
	send(entry: TraceEntry): void {
		this.queue.push(entry);

		// AC-30: drop oldest if queue exceeded
		if (this.queue.length > MAX_QUEUE_SIZE) {
			const dropped = this.queue.length - MAX_QUEUE_SIZE;
			this.queue.splice(0, dropped);
			this.logger("queue_overflow", `dropped ${dropped} oldest entries`);
		}

		if (this.queue.length >= this.batchSize) {
			this._flush();
		}
	}

	/** Flush remaining entries and stop the timer (AC-32). */
	async close(): Promise<void> {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}

		// Final flush with 5s timeout — MUST NOT block indefinitely
		if (this.queue.length > 0) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);
			try {
				await this._doFlush(controller.signal);
			} catch {
				// Best-effort: drop remaining on timeout
			} finally {
				clearTimeout(timeout);
			}
		}
	}

	/** Flush one batch from the front of the queue */
	private async _flush(): Promise<void> {
		if (this.queue.length === 0) return;

		// Check pause from 429
		if (this.paused && Date.now() < this.pauseUntil) {
			return;
		}
		this.paused = false;

		try {
			await this._doFlush();
			this.backoffMs = 1000; // reset on success
		} catch {
			// Errors handled inside _doFlush
		}
	}

	private async _doFlush(signal?: AbortSignal): Promise<void> {
		const batch = this.queue.splice(0, this.batchSize);
		if (batch.length === 0) return;

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-TraceHub-Client": this.clientId,
		};

		if (this.secret) {
			headers["X-TraceHub-Secret"] = this.secret;
		}

		try {
			const res = await fetch(`${this.url}/ingest`, {
				method: "POST",
				headers,
				body: JSON.stringify({ traces: batch }),
				signal,
			});

			if (res.status === 429) {
				// Rate limited — honour Retry-After, pause, exponential backoff (CN-04)
				const retryAfter = Number(res.headers.get("Retry-After") ?? "5");
				const pauseMs = Math.max(retryAfter * 1000, this.backoffMs);
				this.paused = true;
				this.pauseUntil = Date.now() + pauseMs;
				this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);

				// Put batch back at front of queue for retry
				this.queue.unshift(...batch);
				this.logger("rate_limited", `retry_after=${retryAfter}s backoff=${this.backoffMs}ms`);
				return;
			}

			if (!res.ok) {
				// Server error — keep entries for retry
				this.queue.unshift(...batch);
				this.logger("flush_error", `status=${res.status}`);
				return;
			}

			// Success — batch consumed
		} catch (err: unknown) {
			// Network error — keep entries in queue for retry next interval
			this.queue.unshift(...batch);
			this.logger("flush_error", String(err));
		}
	}
}
