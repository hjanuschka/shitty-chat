import type { Request, Response, NextFunction, Router } from "express";
import express from "express";
import { createHash, randomBytes } from "node:crypto";
import { db, type UserRow } from "./db";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const DEV_LOGIN = process.env.NODE_ENV !== "production" && process.env.DEV_LOGIN !== "0";
const COOKIE = "sc_session";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function getUser(req: Request): UserRow | undefined {
  const token = parseCookies(req)[COOKIE];
  if (!token) return undefined;
  const row = db
    .prepare(
      `SELECT u.* FROM user_session s JOIN user_account u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as UserRow | undefined;
  return row;
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = getUser(req);
  if (!user) {
    res.status(401).json({ error: "not_logged_in" });
    return;
  }
  (req as Request & { user: UserRow }).user = user;
  next();
}

function findOrCreateUser(email: string, googleSub?: string): UserRow {
  let user = db.prepare(`SELECT * FROM user_account WHERE email = ?`).get(email) as
    | UserRow
    | undefined;
  if (!user) {
    db.prepare(
      `INSERT INTO user_account (email, google_sub, login_token, created_at) VALUES (?, ?, ?, ?)`,
    ).run(email, googleSub ?? null, randomBytes(24).toString("hex"), Date.now());
    user = db.prepare(`SELECT * FROM user_account WHERE email = ?`).get(email) as UserRow;
  }
  return user;
}

function startSession(res: Response, userId: number) {
  const token = randomBytes(32).toString("hex");
  db.prepare(`INSERT INTO user_session (user_id, token_hash, created_at) VALUES (?, ?, ?)`).run(
    userId,
    sha256(token),
    Date.now(),
  );
  // For cross-origin deploys (split Vercel + Fly.io) cookies need
  // SameSite=None + Secure. Toggle via env.
  const crossSite = process.env.COOKIE_CROSS_SITE === "1";
  const attrs = crossSite ? "SameSite=None; Secure" : "SameSite=Lax";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${token}; HttpOnly; Path=/; ${attrs}; Max-Age=${60 * 60 * 24 * 90}`,
  );
}

export function authRouter(): Router {
  const r = express.Router();

  r.get("/config", (_req, res) => {
    res.json({ googleClientId: GOOGLE_CLIENT_ID || null, devLogin: DEV_LOGIN });
  });

  r.post("/auth/google", async (req, res) => {
    const credential = req.body?.credential;
    if (!GOOGLE_CLIENT_ID || typeof credential !== "string") {
      res.status(400).json({ error: "google_not_configured" });
      return;
    }
    try {
      const resp = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      );
      if (!resp.ok) throw new Error("tokeninfo failed");
      const info = (await resp.json()) as { aud?: string; email?: string; sub?: string };
      if (info.aud !== GOOGLE_CLIENT_ID || !info.email) throw new Error("bad token");
      const user = findOrCreateUser(info.email, info.sub);
      startSession(res, user.id);
      res.json({ ok: true, email: user.email });
    } catch {
      res.status(401).json({ error: "invalid_google_token" });
    }
  });

  r.post("/auth/dev-login", (_req, res) => {
    if (!DEV_LOGIN) {
      res.status(403).json({ error: "dev_login_disabled" });
      return;
    }
    const user = findOrCreateUser("dev@shitty.chat");
    startSession(res, user.id);
    res.json({ ok: true, email: user.email });
  });

  r.post("/auth/token-login", (req, res) => {
    const token = req.body?.token;
    const user = db.prepare(`SELECT * FROM user_account WHERE login_token = ?`).get(token) as
      | UserRow
      | undefined;
    if (!user) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    startSession(res, user.id);
    res.json({ ok: true, email: user.email });
  });

  r.get("/auth/me", (req, res) => {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: "not_logged_in" });
      return;
    }
    res.json({ email: user.email, loginToken: user.login_token });
  });

  r.post("/auth/logout", (req, res) => {
    const token = parseCookies(req)[COOKIE];
    if (token) db.prepare(`DELETE FROM user_session WHERE token_hash = ?`).run(sha256(token));
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  return r;
}
