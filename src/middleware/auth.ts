import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { TRACEHUB_SECRET } from "../lib/config";

/**
 * Auth middleware: verify X-TraceHub-Secret header.
 * - If no secret configured (empty string) -> pass through
 * - If secret configured and header missing -> 401
 * - If secret configured and header wrong -> 403
 */
export const authMiddleware = createMiddleware(async (c, next) => {
	if (!TRACEHUB_SECRET) {
		// No secret configured — allow all
		await next();
		return;
	}

	const headerSecret = c.req.header("X-TraceHub-Secret");

	if (!headerSecret) {
		throw new HTTPException(401, {
			message: "X-TraceHub-Secret header required",
		});
	}

	if (headerSecret !== TRACEHUB_SECRET) {
		throw new HTTPException(403, {
			message: "Invalid TraceHub secret",
		});
	}

	await next();
});
