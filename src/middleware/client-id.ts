import { createMiddleware } from "hono/factory";

/**
 * Client ID middleware: extract X-TraceHub-Client header.
 * Fallback: x-forwarded-for or "unknown".
 * Sets c.set("clientId", value) for downstream middleware.
 */
export const clientIdMiddleware = createMiddleware(async (c, next) => {
	const clientId =
		c.req.header("X-TraceHub-Client") ?? c.req.header("x-forwarded-for") ?? "unknown";

	c.set("clientId", clientId);
	await next();
});
