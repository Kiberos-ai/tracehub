import { Hono } from "hono";
import { cors } from "hono/cors";
import { clientIdMiddleware } from "./middleware/client-id";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { healthRouter } from "./routes/health";
import { ingestRouter } from "./routes/ingest";
import { queryRouter } from "./routes/query";
import { tracingRouter } from "./routes/tracing";
import { adminRouter } from "./routes/admin";
import { docsRouter } from "./routes/docs";
import { docsProvider } from "./docs-provider";

// =============================================================================
// Hono app assembly
// =============================================================================

const app = new Hono();

// CORS — match Python: allow everything
app.use(
	"/*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
		allowHeaders: ["*"],
	}),
);

// Global middleware chain: client ID first, then rate limiting
app.use("/*", clientIdMiddleware);
app.use("/*", rateLimitMiddleware);

// Mount route groups — all paths are baked into the routers
app.route("/", healthRouter);
app.route("/", ingestRouter);
app.route("/", queryRouter);
app.route("/", tracingRouter);
app.route("/", adminRouter);
app.route("/", docsRouter);

// Docs provider (context777 ingest contract) — /help/api/{manifest,export,health}
app.route("/help/api", docsProvider.router);

export { app };
