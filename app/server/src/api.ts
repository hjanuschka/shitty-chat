import express, { type Router, type Request } from "express";
import { randomBytes } from "node:crypto";
import { db, type RoomRow, type RoomAgentRow, type UserRow } from "./db";
import { requireUser } from "./auth";
import type { Relay } from "./relay";

const ROOMS_PER_ACCOUNT = Number(process.env.SC_ROOMS_PER_ACCOUNT ?? 10);

type AuthedRequest = Request & { user: UserRow };

export function apiRouter(relay: Relay): Router {
  const r = express.Router();
  r.use(requireUser);

  const ownRoom = (req: AuthedRequest): RoomRow | undefined => {
    const room = db.prepare(`SELECT * FROM room WHERE id = ?`).get(req.params.id) as
      | RoomRow
      | undefined;
    if (!room || room.user_id !== req.user.id) return undefined;
    return room;
  };

  r.get("/rooms", (req, res) => {
    const rooms = db
      .prepare(`SELECT * FROM room WHERE user_id = ? ORDER BY created_at DESC`)
      .all((req as AuthedRequest).user.id) as RoomRow[];
    res.json(
      rooms.map((room) => ({
        id: room.id,
        name: room.name,
        createdAt: room.created_at,
        agents: relay.members(room.id).filter((m) => m.connected).length,
      })),
    );
  });

  r.post("/rooms", (req, res) => {
    const user = (req as AuthedRequest).user;
    const { name, authTokenHash } = req.body ?? {};
    if (typeof name !== "string" || !name.trim() || !/^[0-9a-f]{64}$/.test(authTokenHash ?? "")) {
      res.status(400).json({ error: "bad_request", message: "need name + authTokenHash (sha256 hex)" });
      return;
    }
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM room WHERE user_id = ?`)
      .get(user.id) as { c: number };
    if (count.c >= ROOMS_PER_ACCOUNT) {
      res.status(403).json({ error: "limit", message: `max ${ROOMS_PER_ACCOUNT} rooms` });
      return;
    }
    const id = `room-${randomBytes(4).toString("hex")}`;
    db.prepare(
      `INSERT INTO room (id, user_id, name, auth_token_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, user.id, name.trim().slice(0, 64), authTokenHash, Date.now());
    res.json({ id, name: name.trim() });
  });

  r.delete("/rooms/:id", (req, res) => {
    const room = ownRoom(req as AuthedRequest);
    if (!room) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    relay.closeRoom(room.id, "room_deleted");
    db.prepare(`DELETE FROM room WHERE id = ?`).run(room.id);
    db.prepare(`DELETE FROM room_agent WHERE room_id = ?`).run(room.id);
    db.prepare(`DELETE FROM room_usage WHERE room_id = ?`).run(room.id);
    res.json({ ok: true });
  });

  r.post("/rooms/:id/rotate-key", (req, res) => {
    const room = ownRoom(req as AuthedRequest);
    if (!room) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { authTokenHash } = req.body ?? {};
    if (!/^[0-9a-f]{64}$/.test(authTokenHash ?? "")) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    db.prepare(`UPDATE room SET auth_token_hash = ? WHERE id = ?`).run(authTokenHash, room.id);
    relay.closeRoom(room.id, "key_rotated");
    res.json({ ok: true });
  });

  r.get("/rooms/:id/agents", (req, res) => {
    const room = ownRoom(req as AuthedRequest);
    if (!room) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // include banned agents too (dashboard needs to unban)
    const agents = db
      .prepare(`SELECT * FROM room_agent WHERE room_id = ?`)
      .all(room.id) as RoomAgentRow[];
    res.json(
      agents.map((a) => ({
        agentId: a.display_id,
        name: a.name,
        platform: a.platform,
        role: room.master_identity_hash === a.identity_hash ? "master" : "slave",
        state: a.state,
        connected: relay.isConnected(room.id, a.identity_hash),
        lastSeen: a.last_seen,
      })),
    );
  });

  r.post("/rooms/:id/agents/:aid/:action", (req, res) => {
    const room = ownRoom(req as AuthedRequest);
    if (!room) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const identityHash = relay.identityHashByAgentId(room.id, req.params.aid);
    if (!identityHash) {
      res.status(404).json({ error: "unknown_agent" });
      return;
    }
    switch (req.params.action) {
      case "kick":
        relay.kick(room.id, identityHash);
        break;
      case "ban":
        relay.setAgentState(room.id, identityHash, "banned");
        break;
      case "unban":
      case "unmute":
        relay.setAgentState(room.id, identityHash, "active");
        break;
      case "mute":
        relay.setAgentState(room.id, identityHash, "muted");
        break;
      case "promote":
        db.prepare(`UPDATE room SET master_identity_hash = ? WHERE id = ?`).run(
          identityHash,
          room.id,
        );
        relay.setAgentState(room.id, identityHash, "active"); // triggers member broadcast
        break;
      default:
        res.status(400).json({ error: "bad_action" });
        return;
    }
    res.json({ ok: true });
  });

  r.get("/rooms/:id/usage", (req, res) => {
    const room = ownRoom(req as AuthedRequest);
    if (!room) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const rows = db
      .prepare(
        `SELECT day, asks, bytes FROM room_usage WHERE room_id = ? ORDER BY day DESC LIMIT 14`,
      )
      .all(room.id);
    res.json(rows);
  });

  return r;
}
