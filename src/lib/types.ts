import { z } from "zod";

// =============================================================================
// Zod schemas — match Python models.py field names exactly (CR-03)
// =============================================================================

/** Single trace entry from checkpoint logger */
export const TraceEntrySchema = z.object({
	source_id: z.string(),
	correlation_id: z.string(),
	timestamp: z.number(),
	suffix: z.string(),
	direction: z.string(),
	operation: z.string(),
	endpoint: z.string(),
	data: z.record(z.unknown()).optional(),
	hostname: z.string().default("unknown"),
	raw_line: z.string().optional(),
});

/** Batch ingest request */
export const TraceIngestRequestSchema = z.object({
	traces: z.array(TraceEntrySchema),
});

/** Query response with traces */
export const TraceQueryResponseSchema = z.object({
	correlation_id: z.string(),
	traces: z.array(TraceEntrySchema),
	count: z.number(),
	complete: z.boolean().default(false),
});

// =============================================================================
// Inferred TypeScript types
// =============================================================================

export type TraceEntry = z.infer<typeof TraceEntrySchema>;
export type TraceIngestRequest = z.infer<typeof TraceIngestRequestSchema>;
export type TraceQueryResponse = z.infer<typeof TraceQueryResponseSchema>;
