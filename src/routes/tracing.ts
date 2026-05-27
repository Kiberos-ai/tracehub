import { Hono } from "hono";
import {
	markHot,
	getState,
	removeCorrId,
	getConfigEtag,
	getConfigPayload,
	getStatusPayload,
} from "../services/adaptive";
import { addWaiter } from "../services/long-poll";
import { ADAPTIVE_HOT_TTL } from "../lib/config";

export const tracingRouter = new Hono();

tracingRouter.get("/tracing/config", async (c) => {
	const etagStr = String(getConfigEtag());
	const ifNoneMatch = c.req.header("If-None-Match")?.replace(/"/g, "");

	// Parse Prefer header for long-poll: "wait=N" (seconds)
	const preferHeader = c.req.header("Prefer");
	let waitMs = 0;
	if (preferHeader) {
		const match = preferHeader.match(/wait=(\d+)/);
		if (match) {
			waitMs = Math.min(Number(match[1]) * 1000, 60_000); // cap 60s
		}
	}

	// No Prefer header -> immediate response (backward compat, CN-05)
	if (!preferHeader || waitMs === 0) {
		if (ifNoneMatch && ifNoneMatch === etagStr) {
			return new Response(null, {
				status: 304,
				headers: { ETag: `"${etagStr}"` },
			});
		}
		const payload = getConfigPayload();
		c.header("ETag", `"${etagStr}"`);
		return c.json(payload);
	}

	// Long-poll: etag matches -> wait for change or timeout
	if (ifNoneMatch && ifNoneMatch === etagStr) {
		const reason = await addWaiter(waitMs);
		if (reason === "timeout") {
			return new Response(null, {
				status: 304,
				headers: { ETag: `"${etagStr}"` },
			});
		}
		// "changed" — return fresh config
		const freshEtag = String(getConfigEtag());
		const payload = getConfigPayload();
		c.header("ETag", `"${freshEtag}"`);
		return c.json(payload);
	}

	// Etag doesn't match -> immediate 200 with current config
	const payload = getConfigPayload();
	c.header("ETag", `"${etagStr}"`);
	return c.json(payload);
});

tracingRouter.get("/tracing/status", (c) => {
	return c.json(getStatusPayload());
});

tracingRouter.post("/tracing/enable/:corrId", (c) => {
	const corrId = c.req.param("corrId");
	const previous = markHot(corrId);
	return c.json({
		correlation_id: corrId,
		state: "hot",
		previous_state: previous,
		ttl: ADAPTIVE_HOT_TTL,
	});
});

tracingRouter.post("/tracing/disable/:corrId", (c) => {
	const corrId = c.req.param("corrId");
	const previous = removeCorrId(corrId);
	return c.json({
		correlation_id: corrId,
		state: "cold",
		previous_state: previous,
	});
});
