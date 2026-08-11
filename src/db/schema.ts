import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const traces = sqliteTable(
	"traces",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		sourceId: text("source_id").notNull(),
		correlationId: text("correlation_id").notNull(),
		timestamp: real("timestamp").notNull(),
		suffix: text("suffix").notNull(),
		direction: text("direction").notNull(),
		operation: text("operation").notNull(),
		endpoint: text("endpoint").notNull(),
		data: text("data"),
		hostname: text("hostname"),
		rawLine: text("raw_line"),
		createdAt: real("created_at").default(sql`(strftime('%s','now'))`),
	},
	(table) => [
		uniqueIndex("uq_dedup_trace").on(table.correlationId, table.timestamp, table.suffix),
		index("idx_correlation_id").on(table.correlationId),
		index("idx_timestamp").on(table.timestamp),
		index("idx_source_id").on(table.sourceId),
		index("idx_dedup").on(table.sourceId, table.correlationId, table.endpoint, table.direction),
	],
);
