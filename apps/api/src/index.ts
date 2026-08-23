import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { ConfigValidationError } from "./config/runtime.ts";
import { MAX_REQUEST_BODY_BYTES, MAX_CHAT_REQUEST_BODY_BYTES } from "./config/security-policy.ts";
import { resolveMongo } from "./infrastructure/mongo/resolve-db.ts";
import type { AuthVariables } from "./middleware/auth.ts";
import authRoutes from "./routes/auth.ts";
import signupRoutes from "./routes/signup.ts";
import customers from "./routes/customers.ts";
import providers from "./routes/providers.ts";
import models from "./routes/models.ts";
import plans from "./routes/plans.ts";
import apiKeys from "./routes/api-keys.ts";
import inviteRoutes, { acceptInviteRoute } from "./routes/invites.ts";
import organizationRoutes from "./routes/organizations.ts";
import playgroundRoutes from "./routes/playground.ts";
import catalogSourceRoutes from "./routes/catalog-sources.ts";
import managementKeyRoutes from "./routes/management-keys.ts";
import managementRead from "./routes/management/read.ts";
import managementWrite from "./routes/management/write.ts";
import dashboardRoutes from "./routes/dashboard.ts";
import analyticsSummaryRoutes from "./routes/analytics-summary.ts";
import publicOpenAI from "./routes/public/openai.ts";
import publicAnthropic from "./routes/public/anthropic.ts";
import paymentRoutes from "./routes/payments.ts";
import { requirePublicPrincipal } from "./middleware/public-auth.ts";
import { requireManagementPrincipal } from "./middleware/management-auth.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import "./providers/index.ts";
import { bootApi, registerShutdownSignals, shutdownApi, BootError } from "./runtime/boot.ts";
import { WorkerControl } from "./runtime/services/worker-control.ts";

const boot = await (async () => {
  try {
    return await bootApi({ registerSignals: true, installRuntime: true, applyProcessGlobals: true, runPreMigrations: true });
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      for (const issue of err.issues) console.error(`config: ${issue.variable}: ${issue.reason}`);
    } else if (err instanceof BootError) {
      console.error(`boot[${err.phase}]: ${err.message}`);
    } else {
      console.error(err instanceof Error ? err.message : err);
    }
    process.exit(1);
  }
})();

const { config: runtimeConfig, runtime, mongo } = boot;
const app = new Hono<{ Variables: AuthVariables }>();
app.use("*", securityHeaders);
const bodyTooLarge = (c: { json: (b: unknown, s: 413) => Response }) => c.json({ error: "payload_too_large", message: "Request body too large" }, 413);
app.use("*", async (c, next) => {
  const isChatSurface = c.req.path.startsWith("/v1/") || c.req.path.startsWith("/admin/playground/");
  return bodyLimit({ maxSize: isChatSurface ? MAX_CHAT_REQUEST_BODY_BYTES : MAX_REQUEST_BODY_BYTES, onError: bodyTooLarge })(c, next);
});
const allowedOrigins = runtimeConfig.corsOrigins;
app.use("*", cors({ origin: (origin) => { if (!origin) return null; if (allowedOrigins === null) return origin; return allowedOrigins.includes(origin) ? origin : null; }, allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization"], credentials: false, maxAge: 600 }));
app.get("/health", async (c) => { try { const { rawDb } = await resolveMongo(); await rawDb.command({ ping: 1 }); return c.json({ status: "ok" }); } catch { return c.json({ status: "unavailable" }, 503); } });
app.route("/admin/auth", authRoutes);
app.route("/admin/auth", signupRoutes);
app.route("/admin/auth", acceptInviteRoute);
app.route("/admin/customers", customers);
app.route("/admin/dashboard", dashboardRoutes);
app.route("/admin/analytics", analyticsSummaryRoutes);
app.route("/admin/providers", providers);
app.route("/admin/models", models);
app.route("/admin/plans", plans);
app.route("/admin/api-keys", apiKeys);
app.route("/admin/invites", inviteRoutes);
app.route("/admin/organizations", organizationRoutes);
app.route("/admin/playground", playgroundRoutes);
app.route("/admin/catalog-sources", catalogSourceRoutes);
app.route("/admin/management-keys", managementKeyRoutes);
app.route("/api/payments", paymentRoutes);
app.use("/v1/*", requirePublicPrincipal);
app.route("/", publicOpenAI);
app.route("/", publicAnthropic);
app.use("/api/management/*", requirePublicPrincipal);
app.use("/api/management/*", requireManagementPrincipal);
app.route("/api/management", managementRead);
app.route("/api/management", managementWrite);
const adminDistDir = resolve(import.meta.dirname, "../../admin/dist");
const hasAdminDist = existsSync(join(adminDistDir, "index.html"));
if (hasAdminDist) {
  app.use("/assets/*", serveStatic({ root: adminDistDir, onFound: (_path, c) => { c.header("Cache-Control", "public, max-age=31536000, immutable"); } }));
  app.get("/logo.png", serveStatic({ root: adminDistDir }));
  app.get("/icons.svg", serveStatic({ root: adminDistDir }));
  console.log(`admin SPA: serving from ${adminDistDir}`);
} else console.log("admin SPA: dist not built, skipping static serving");
app.notFound((c) => { const accept = c.req.header("Accept") ?? ""; const wantsHtml = accept.includes("text/html"); const wantsSse = accept.includes("text/event-stream"); if (c.req.method === "GET" && wantsHtml && !wantsSse && hasAdminDist) return c.body(Bun.file(join(adminDistDir, "index.html")).stream()); return c.json({ error: "not_found" }, 404); });
app.onError((err, c) => { console.error(err); return c.json({ error: "internal_server_error" }, 500); });
const port = runtimeConfig.port;
console.log("mongodb ready");
Bun.serve({ port, idleTimeout: 0, fetch(req, server) { return app.fetch(req, { server }); } });
console.log(`api listening on http://localhost:${port}`);
await runtime.runPromise(Effect.gen(function* () { const workers = yield* WorkerControl; yield* workers.start(); }));
registerShutdownSignals(runtimeConfig);
void mongo;
void shutdownApi;
export { app, runtime, runtimeConfig };
