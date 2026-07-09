import express from "express";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { authRouter } from "./auth";
import { apiRouter } from "./api";
import { Relay } from "./relay";

const PORT = Number(process.env.PORT ?? 8787);
const WEB_DIST = process.env.SHITTY_CHAT_WEB_DIST ?? join(process.cwd(), "web", "dist");
// Comma-separated list of origins allowed to hit /api. Only needed for the
// split deploy (dashboard on Vercel, relay on Fly.io etc.). Same-origin
// deploys can leave this unset.
const ALLOW_ORIGINS = (process.env.CORS_ALLOW_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(express.json({ limit: "2mb" }));

if (ALLOW_ORIGINS.length > 0) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (ALLOW_ORIGINS.includes("*") || ALLOW_ORIGINS.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
}

const relay = new Relay();

app.use("/api/v1", authRouter());
app.use("/api/v1/product", apiRouter(relay));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Serve the built dashboard when present (production single-container mode).
// In dev, vite runs on :5173 and proxies /api + /ws here instead.
if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get(/^\/(?!api|ws|healthz).*/, (_req, res) => {
    res.sendFile(join(WEB_DIST, "index.html"));
  });
  console.log(`[shitty-chat] serving dashboard from ${WEB_DIST}`);
}

const server = createServer(app);
relay.attach(server);

server.listen(PORT, () => {
  console.log(`[shitty-chat] server on http://localhost:${PORT} (ws: /ws)`);
});
