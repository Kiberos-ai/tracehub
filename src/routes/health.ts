import { Hono } from "hono";
import { TRACEHUB_DB, TRACEHUB_RETENTION_HOURS } from "../lib/config";

export const healthRouter = new Hono();

healthRouter.get("/health", (c) => {
	return c.json({
		status: "healthy",
		service: "tracehub",
		db: TRACEHUB_DB,
		retention_hours: TRACEHUB_RETENTION_HOURS,
	});
});
