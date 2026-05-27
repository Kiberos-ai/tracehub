// =============================================================================
// SDK Logger — [TracHub] prefixed, wraps user-provided or default (REQ-35)
// =============================================================================

export type LoggerFn = (event: string, details: string) => void;

/** Events the SDK logs */
export type LogEvent =
	| "rate_limited"
	| "banned"
	| "connection_lost"
	| "reconnecting"
	| "backoff"
	| "config_updated"
	| "flush_error"
	| "queue_overflow";

const defaultLogger: LoggerFn = (event: string, details: string) => {
	console.warn(`[TracHub] ${event}: ${details}`);
};

/** Create a logger wrapping user-provided function or default console.warn */
export function createLogger(userLogger?: LoggerFn): LoggerFn {
	return userLogger ?? defaultLogger;
}
