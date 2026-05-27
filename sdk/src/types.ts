// =============================================================================
// SDK Types — must match server TraceEntry schema (snake_case, CR-03)
// =============================================================================

/** SDK configuration */
export interface TraceHubConfig {
	url: string;
	secret?: string;
	clientId?: string;
	projectName?: string;
	sourceId?: string;
	batchSize?: number;
	flushInterval?: number;
	logger?: (event: string, details: string) => void;
	adaptiveTracing?: boolean;
}

/** Single trace entry matching server schema */
export interface TraceEntry {
	source_id: string;
	correlation_id: string;
	timestamp: number;
	suffix: string;
	direction: string;
	operation: string;
	endpoint: string;
	data?: Record<string, unknown>;
	hostname?: string;
}

/** Adaptive tracing config received from server */
export interface AdaptiveConfig {
	mode: string;
	default_rate: number;
	warm_rate: number;
	hot_correlations: Record<string, { rate: number; ttl: number }>;
	etag: string;
}
