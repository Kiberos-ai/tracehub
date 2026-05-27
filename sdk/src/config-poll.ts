// =============================================================================
// ConfigPoller — long-poll /tracing/config for adaptive tracing updates
// =============================================================================

import type { AdaptiveConfig } from "./types";
import type { LoggerFn } from "./logger";

export class ConfigPoller {
	private url: string;
	private clientId: string;
	private secret: string | undefined;
	private logger: LoggerFn;

	private config: AdaptiveConfig = {
		mode: "adaptive",
		default_rate: 0,
		warm_rate: 0.1,
		hot_correlations: {},
		etag: "",
	};

	private abortController: AbortController | null = null;
	private running = false;
	private backoffMs = 1000;
	private readonly maxBackoffMs = 5 * 60 * 1000; // 5 min cap
	private pollTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		url: string,
		clientId: string,
		secret: string | undefined,
		logger: LoggerFn,
	) {
		this.url = url;
		this.clientId = clientId;
		this.secret = secret;
		this.logger = logger;
	}

	/** Start the long-poll loop */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.abortController = new AbortController();
		this._poll();
	}

	/** O(1) decision: should this correlation be traced? (CR-06) */
	shouldTrace(corrId: string): boolean {
		// Hot correlation — always trace
		if (corrId in this.config.hot_correlations) {
			return true;
		}
		// Default rate sampling
		return Math.random() < this.config.default_rate;
	}

	/** Get current adaptive config snapshot */
	getConfig(): Readonly<AdaptiveConfig> {
		return this.config;
	}

	/** Stop the poll loop and cancel in-flight request */
	close(): void {
		this.running = false;
		if (this.pollTimer !== null) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}

	private _schedulePoll(delayMs: number): void {
		if (!this.running) return;
		this.pollTimer = setTimeout(() => {
			this.pollTimer = null;
			this._poll();
		}, delayMs);
	}

	private async _poll(): Promise<void> {
		if (!this.running) return;

		const headers: Record<string, string> = {
			"Prefer": "wait=30",
			"X-TraceHub-Client": this.clientId,
		};

		if (this.config.etag) {
			headers["If-None-Match"] = `"${this.config.etag}"`;
		}

		if (this.secret) {
			headers["X-TraceHub-Secret"] = this.secret;
		}

		try {
			const res = await fetch(`${this.url}/tracing/config`, {
				headers,
				signal: this.abortController?.signal,
			});

			if (res.status === 200) {
				const body = (await res.json()) as AdaptiveConfig;
				this.config = body;
				this.backoffMs = 1000; // reset backoff on success
				this.logger("config_updated", `etag=${body.etag} hot=${Object.keys(body.hot_correlations).length}`);
				// Immediately poll again for next change
				this._schedulePoll(0);
				return;
			}

			if (res.status === 304) {
				// Not modified — schedule with jitter (0-5s) (AC-06)
				const jitter = Math.random() * 5000;
				this._schedulePoll(jitter);
				return;
			}

			if (res.status === 429) {
				// Rate limited or banned — honour Retry-After (CN-04, CR-08)
				const retryAfter = Number(res.headers.get("Retry-After") ?? "60");
				const pauseMs = retryAfter * 1000;
				const body = await res.json().catch(() => ({})) as Record<string, unknown>;
				const isBan = typeof body.error === "string" && body.error.includes("ban");
				this.logger(
					isBan ? "banned" : "rate_limited",
					`retry_after=${retryAfter}s`,
				);
				this._schedulePoll(pauseMs);
				return;
			}

			// Other error — treat as transient
			this.logger("connection_lost", `status=${res.status}`);
			this._scheduleBackoff();
		} catch (err: unknown) {
			// Network error or abort
			if (err instanceof DOMException && err.name === "AbortError") {
				return; // intentional close
			}
			// Connection lost — set default_rate=0 (COLD), exponential backoff (REQ-30)
			this.config = { ...this.config, default_rate: 0 };
			this.logger("connection_lost", String(err));
			this._scheduleBackoff();
		}
	}

	private _scheduleBackoff(): void {
		this.logger("backoff", `${this.backoffMs}ms`);
		this._schedulePoll(this.backoffMs);
		this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
	}
}
