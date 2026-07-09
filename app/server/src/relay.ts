import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { db, bumpUsage, asksToday, type RoomRow, type RoomAgentRow } from "./db";
import type {
  Envelope,
  HelloPayload,
  AskPayload,
  AskAckPayload,
  AskResponsePayload,
  MemberInfo,
  ModerationPayload,
  SayPayload,
  TurnPayload,
  TurnResponsePayload,
} from "../../../shared/protocol";

const LIMITS = {
  agentsPerRoom: Number(process.env.SC_AGENTS_PER_ROOM ?? 10),
  asksPerDay: Number(process.env.SC_ASKS_PER_DAY ?? 500),
  asksPerMinute: Number(process.env.SC_ASKS_PER_MINUTE ?? 30),
  maxPayloadBytes: Number(process.env.SC_MAX_PAYLOAD ?? 1_200_000),
  // rooms with no connected agents for this long are garbage-collected
  emptyRoomTtlMs: Number(process.env.SC_EMPTY_ROOM_TTL_MS ?? 20 * 60 * 1000),
  reaperIntervalMs: Number(process.env.SC_REAPER_INTERVAL_MS ?? 60 * 1000),
};

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

interface Conn {
  ws: WebSocket;
  roomId: string;
  identityHash: string;
  agentId: string;
  name: string;
  platform: string;
  askTimestamps: number[];
  alive: boolean;
}

interface AskRoute {
  roomId: string;
  askerIdentity: string;
  ts: number;
}

interface TurnRoute {
  roomId: string;
  provokerIdentity: string;
  ts: number;
}

export class Relay {
  private rooms = new Map<string, Map<string, Conn>>(); // roomId -> identityHash -> conn
  private asks = new Map<string, AskRoute>();
  private turnRoutes = new Map<string, TurnRoute>();
  // per-room timestamp when the room went to zero connected agents.
  // undefined means "currently occupied"; set means "empty since this time".
  private emptyAt = new Map<string, number>();

  attach(server: Server) {
    const wss = new WebSocketServer({ server, path: "/ws", maxPayload: LIMITS.maxPayloadBytes });
    wss.on("connection", (ws) => this.onConnection(ws));
    setInterval(() => this.heartbeat(), 30_000);
    setInterval(() => this.expireAsks(), 60_000);
    setInterval(() => this.reapEmptyRooms(), LIMITS.reaperIntervalMs);

    // On boot, every existing room has 0 live connections -> mark them empty
    // as of now so the TTL runs from server start.
    const now = Date.now();
    const roomIds = db.prepare(`SELECT id FROM room`).all() as Array<{ id: string }>;
    for (const { id } of roomIds) this.emptyAt.set(id, now);
  }

  // ---- helpers ----

  private send(ws: WebSocket, msg: Envelope) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private error(ws: WebSocket, code: string, message: string) {
    this.send(ws, { type: "error", payload: { code, message } });
  }

  private roomConns(roomId: string): Map<string, Conn> {
    let m = this.rooms.get(roomId);
    if (!m) {
      m = new Map();
      this.rooms.set(roomId, m);
    }
    return m;
  }

  private getRoom(roomId: string): RoomRow | undefined {
    return db.prepare(`SELECT * FROM room WHERE id = ?`).get(roomId) as RoomRow | undefined;
  }

  members(roomId: string): MemberInfo[] {
    const room = this.getRoom(roomId);
    const agents = db
      .prepare(`SELECT * FROM room_agent WHERE room_id = ? AND state != 'banned'`)
      .all(roomId) as RoomAgentRow[];
    const conns = this.roomConns(roomId);
    return agents.map((a) => ({
      agentId: a.display_id,
      name: a.name,
      platform: a.platform,
      role: room?.master_identity_hash === a.identity_hash ? "master" : "slave",
      state: a.state as MemberInfo["state"],
      connected: conns.has(a.identity_hash),
      lastSeen: a.last_seen,
    }));
  }

  isConnected(roomId: string, identityHash: string): boolean {
    return this.roomConns(roomId).has(identityHash);
  }

  private broadcastMembers(roomId: string, event: string, agentId?: string) {
    const members = this.members(roomId);
    for (const conn of this.roomConns(roomId).values()) {
      this.send(conn.ws, { type: "member_update", payload: { event, agentId, members } });
    }
  }

  private findConnByAgentId(roomId: string, agentId: string): Conn | undefined {
    for (const conn of this.roomConns(roomId).values()) {
      if (conn.agentId === agentId) return conn;
    }
    return undefined;
  }

  private agentRow(roomId: string, identityHash: string): RoomAgentRow | undefined {
    return db
      .prepare(`SELECT * FROM room_agent WHERE room_id = ? AND identity_hash = ?`)
      .get(roomId, identityHash) as RoomAgentRow | undefined;
  }

  // ---- moderation API used by REST + master commands ----

  setAgentState(roomId: string, identityHash: string, state: "active" | "muted" | "banned") {
    db.prepare(`UPDATE room_agent SET state = ? WHERE room_id = ? AND identity_hash = ?`).run(
      state,
      roomId,
      identityHash,
    );
    if (state === "banned") this.disconnectAgent(roomId, identityHash, "banned");
    this.broadcastMembers(roomId, state);
  }

  kick(roomId: string, identityHash: string) {
    this.disconnectAgent(roomId, identityHash, "kicked");
    this.broadcastMembers(roomId, "kicked");
  }

  identityHashByAgentId(roomId: string, agentId: string): string | undefined {
    const row = db
      .prepare(`SELECT identity_hash FROM room_agent WHERE room_id = ? AND display_id = ?`)
      .get(roomId, agentId) as { identity_hash: string } | undefined;
    return row?.identity_hash;
  }

  private disconnectAgent(roomId: string, identityHash: string, reason: string) {
    const conn = this.roomConns(roomId).get(identityHash);
    if (conn) {
      this.send(conn.ws, { type: "bye", payload: { reason } });
      conn.ws.close();
      this.roomConns(roomId).delete(identityHash);
    }
  }

  closeRoom(roomId: string, reason: "key_rotated" | "room_deleted") {
    for (const conn of [...this.roomConns(roomId).values()]) {
      this.send(conn.ws, { type: "bye", payload: { reason } });
      conn.ws.close();
    }
    this.rooms.delete(roomId);
  }

  // ---- connection lifecycle ----

  private onConnection(ws: WebSocket) {
    let conn: Conn | undefined;

    ws.on("pong", () => {
      if (conn) conn.alive = true;
    });

    ws.on("message", (data) => {
      let msg: Envelope;
      try {
        msg = JSON.parse(String(data));
      } catch {
        this.error(ws, "bad_json", "could not parse message");
        return;
      }

      if (!conn) {
        if (msg.type !== "hello") {
          this.error(ws, "not_authed", "first message must be hello");
          ws.close();
          return;
        }
        conn = this.handleHello(ws, msg.payload as HelloPayload);
        return;
      }

      try {
        this.handleMessage(conn, msg);
      } catch (err) {
        this.error(ws, "internal", String(err));
      }
    });

    ws.on("close", () => {
      if (!conn) return;
      // If this connection was already replaced by a fresh hello for the
      // same identity, do NOT delete the map entry (that would be the new
      // conn) and do NOT broadcast a leave: the identity is still online.
      if ((conn as Conn & { replaced?: boolean }).replaced) return;
      const current = this.roomConns(conn.roomId).get(conn.identityHash);
      if (current !== conn) return; // paranoia: also skip if map holds something else
      this.roomConns(conn.roomId).delete(conn.identityHash);
      db.prepare(`UPDATE room_agent SET last_seen = ? WHERE room_id = ? AND identity_hash = ?`).run(
        Date.now(),
        conn.roomId,
        conn.identityHash,
      );
      this.broadcastMembers(conn.roomId, "leave", conn.agentId);
      if (this.roomConns(conn.roomId).size === 0) this.emptyAt.set(conn.roomId, Date.now());
    });
  }

  private handleHello(ws: WebSocket, payload: HelloPayload): Conn | undefined {
    if (!payload?.authKey || !payload?.identity) {
      this.error(ws, "bad_auth", "missing authKey/identity");
      ws.close();
      return undefined;
    }
    const room = db
      .prepare(`SELECT * FROM room WHERE auth_token_hash = ?`)
      .get(sha256(payload.authKey)) as RoomRow | undefined;
    if (!room) {
      this.error(ws, "bad_auth", "unknown room key");
      ws.close();
      return undefined;
    }

    const identityHash = sha256(payload.identity);
    const existing = this.agentRow(room.id, identityHash);

    if (existing?.state === "banned") {
      this.error(ws, "banned", "you are banned from this room");
      ws.close();
      return undefined;
    }

    const conns = this.roomConns(room.id);
    if (!conns.has(identityHash) && conns.size >= LIMITS.agentsPerRoom) {
      this.error(ws, "room_full", `room limit is ${LIMITS.agentsPerRoom} agents`);
      ws.close();
      return undefined;
    }

    // replace stale connection of same identity. Mark it so its close
    // handler does not clobber the fresh conn we're about to insert.
    const stale = conns.get(identityHash);
    if (stale) {
      (stale as Conn & { replaced?: boolean }).replaced = true;
      stale.ws.close();
    }

    const name = String(payload.name || "agent").slice(0, 64);
    const platform = String(payload.platform || "unknown").slice(0, 16);
    // name is "user@host:cwdbase"; prefer the project dir, fall back to host
    const afterAt = name.split("@").pop() ?? "";
    const hostPart =
      (afterAt.split(":").pop() || afterAt)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 12) || "agent";
    const agentId = existing?.display_id ?? `${hostPart}-${identityHash.slice(0, 4)}`;

    db.prepare(
      `INSERT INTO room_agent (room_id, identity_hash, display_id, name, platform, state, last_seen)
       VALUES (?, ?, ?, ?, ?, 'active', ?)
       ON CONFLICT(room_id, identity_hash) DO UPDATE SET name = excluded.name,
         platform = excluded.platform, last_seen = excluded.last_seen`,
    ).run(room.id, identityHash, agentId, name, platform, Date.now());

    // first joiner becomes master
    if (!room.master_identity_hash) {
      db.prepare(`UPDATE room SET master_identity_hash = ? WHERE id = ?`).run(
        identityHash,
        room.id,
      );
      room.master_identity_hash = identityHash;
    }

    // room is now occupied - clear any pending reap
    this.emptyAt.delete(room.id);

    const conn: Conn = {
      ws,
      roomId: room.id,
      identityHash,
      agentId,
      name,
      platform,
      askTimestamps: [],
      alive: true,
    };
    conns.set(identityHash, conn);

    const role = room.master_identity_hash === identityHash ? "master" : "slave";
    this.send(ws, {
      type: "welcome",
      payload: { agentId, role, roomName: room.name, members: this.members(room.id) },
    });
    this.broadcastMembers(room.id, "join", agentId);
    return conn;
  }

  private handleMessage(conn: Conn, msg: Envelope) {
    switch (msg.type) {
      case "ping":
        this.send(conn.ws, { type: "pong" });
        return;
      case "room_members":
        this.send(conn.ws, {
          type: "member_update",
          payload: { event: "list", members: this.members(conn.roomId) },
        });
        return;
      case "room_kick":
      case "room_ban":
      case "room_unban":
      case "room_mute":
      case "room_unmute":
        this.handleModeration(conn, msg.type, msg.payload as ModerationPayload);
        return;
      case "ask":
        this.handleAsk(conn, msg.payload as AskPayload);
        return;
      case "say":
        this.handleSay(conn, msg.payload as SayPayload);
        return;
      case "turn":
        this.handleTurn(conn, msg.payload as TurnPayload);
        return;
      case "turn_response":
        this.routeTurnResponse(conn, msg.payload as TurnResponsePayload);
        return;
      case "ask_ack":
        this.routeToAsker(conn, "ask_ack", msg.payload as AskAckPayload);
        return;
      case "ask_response":
        this.routeToAsker(conn, "ask_response", msg.payload as AskResponsePayload);
        return;
      default:
        this.error(conn.ws, "unknown_type", `unknown message type: ${msg.type}`);
    }
  }

  private handleModeration(conn: Conn, type: string, payload: ModerationPayload) {
    const room = this.getRoom(conn.roomId);
    if (room?.master_identity_hash !== conn.identityHash) {
      this.error(conn.ws, "not_master", "only the master can do that");
      return;
    }
    const targetHash = this.identityHashByAgentId(conn.roomId, payload?.targetAgentId ?? "");
    if (!targetHash) {
      this.error(conn.ws, "unknown_agent", `no such agent: ${payload?.targetAgentId}`);
      return;
    }
    if (targetHash === conn.identityHash) {
      this.error(conn.ws, "self_moderation", "cannot moderate yourself");
      return;
    }
    switch (type) {
      case "room_kick":
        this.kick(conn.roomId, targetHash);
        break;
      case "room_ban":
        this.setAgentState(conn.roomId, targetHash, "banned");
        break;
      case "room_unban":
        this.setAgentState(conn.roomId, targetHash, "active");
        break;
      case "room_mute":
        this.setAgentState(conn.roomId, targetHash, "muted");
        break;
      case "room_unmute":
        this.setAgentState(conn.roomId, targetHash, "active");
        break;
    }
  }

  private handleAsk(conn: Conn, payload: AskPayload) {
    if (!payload?.askId || !payload?.prompt) {
      this.error(conn.ws, "bad_ask", "missing askId/prompt");
      return;
    }

    const me = this.agentRow(conn.roomId, conn.identityHash);
    if (me?.state === "muted") {
      this.error(conn.ws, "muted", "you are muted in this room");
      return;
    }

    // rate limits
    const now = Date.now();
    conn.askTimestamps = conn.askTimestamps.filter((t) => now - t < 60_000);
    if (conn.askTimestamps.length >= LIMITS.asksPerMinute) {
      this.error(conn.ws, "rate_limited", "too many asks per minute");
      return;
    }
    if (asksToday(conn.roomId) >= LIMITS.asksPerDay) {
      this.error(conn.ws, "rate_limited", "daily ask quota reached for this room");
      return;
    }
    conn.askTimestamps.push(now);

    const size = JSON.stringify(payload).length;
    bumpUsage(conn.roomId, 1, size);
    this.asks.set(payload.askId, { roomId: conn.roomId, askerIdentity: conn.identityHash, ts: now });

    const targets: Conn[] = [];
    if (payload.target && payload.target !== "all") {
      const t = this.findConnByAgentId(conn.roomId, payload.target);
      if (!t) {
        this.error(conn.ws, "unknown_agent", `agent not connected: ${payload.target}`);
        return;
      }
      targets.push(t);
    } else {
      for (const c of this.roomConns(conn.roomId).values()) {
        if (c.identityHash !== conn.identityHash) targets.push(c);
      }
    }

    let delivered = 0;
    for (const t of targets) {
      const row = this.agentRow(conn.roomId, t.identityHash);
      if (row?.state === "muted") continue; // fully isolate muted agents from asks
      this.send(t.ws, { type: "ask_received", from: conn.agentId, payload });
      delivered++;
    }
    if (delivered === 0) {
      this.error(conn.ws, "no_targets", "nobody to ask (no other active agents connected)");
    }
  }

  private handleTurn(conn: Conn, payload: TurnPayload) {
    if (!payload?.turnId || !payload?.prompt) {
      this.error(conn.ws, "bad_turn", "missing turnId/prompt");
      return;
    }
    const me = this.agentRow(conn.roomId, conn.identityHash);
    if (me?.state === "muted") {
      this.error(conn.ws, "muted", "you are muted in this room");
      return;
    }
    // rate-limit like asks (a turn is at least as expensive)
    const now = Date.now();
    conn.askTimestamps = conn.askTimestamps.filter((t) => now - t < 60_000);
    if (conn.askTimestamps.length >= LIMITS.asksPerMinute) {
      this.error(conn.ws, "rate_limited", "too many turns per minute");
      return;
    }
    conn.askTimestamps.push(now);
    bumpUsage(conn.roomId, 1, JSON.stringify(payload).length);
    this.turnRoutes.set(payload.turnId, {
      roomId: conn.roomId,
      provokerIdentity: conn.identityHash,
      ts: now,
    });

    const targets: Conn[] = [];
    if (payload.target && payload.target !== "all") {
      const t = this.findConnByAgentId(conn.roomId, payload.target);
      if (!t) {
        this.error(conn.ws, "unknown_agent", `agent not connected: ${payload.target}`);
        return;
      }
      targets.push(t);
    } else {
      for (const c of this.roomConns(conn.roomId).values()) {
        if (c.identityHash !== conn.identityHash) targets.push(c);
      }
    }
    for (const t of targets) {
      const row = this.agentRow(conn.roomId, t.identityHash);
      if (row?.state === "muted") continue;
      this.send(t.ws, { type: "turn_received", from: conn.agentId, payload });
    }
  }

  private routeTurnResponse(conn: Conn, payload: TurnResponsePayload) {
    const route = this.turnRoutes.get(payload?.turnId ?? "");
    if (!route || route.roomId !== conn.roomId) return;
    const provoker = this.roomConns(conn.roomId).get(route.provokerIdentity);
    if (!provoker) return;
    bumpUsage(conn.roomId, 0, JSON.stringify(payload).length);
    this.send(provoker.ws, { type: "turn_response", from: conn.agentId, payload });
  }

  private handleSay(conn: Conn, payload: SayPayload) {
    if (!payload?.sayId || !payload?.text) {
      this.error(conn.ws, "bad_say", "missing sayId/text");
      return;
    }
    const me = this.agentRow(conn.roomId, conn.identityHash);
    if (me?.state === "muted") {
      this.error(conn.ws, "muted", "you are muted in this room");
      return;
    }
    bumpUsage(conn.roomId, 0, JSON.stringify(payload).length);
    for (const c of this.roomConns(conn.roomId).values()) {
      if (c.identityHash === conn.identityHash) continue;
      const row = this.agentRow(conn.roomId, c.identityHash);
      if (row?.state === "muted") continue;
      this.send(c.ws, { type: "say_received", from: conn.agentId, payload });
    }
  }

  private routeToAsker(conn: Conn, type: string, payload: { askId: string }) {
    const route = this.asks.get(payload?.askId ?? "");
    if (!route || route.roomId !== conn.roomId) return;
    const asker = this.roomConns(conn.roomId).get(route.askerIdentity);
    if (!asker) return;
    bumpUsage(conn.roomId, 0, JSON.stringify(payload).length);
    this.send(asker.ws, { type, from: conn.agentId, payload });
  }

  private heartbeat() {
    for (const conns of this.rooms.values()) {
      for (const conn of [...conns.values()]) {
        if (!conn.alive) {
          conn.ws.terminate();
          conns.delete(conn.identityHash);
          this.broadcastMembers(conn.roomId, "leave", conn.agentId);
          continue;
        }
        conn.alive = false;
        conn.ws.ping();
      }
    }
  }

  private expireAsks() {
    const cutoff = Date.now() - 310_000;
    for (const [id, route] of this.asks) {
      if (route.ts < cutoff) this.asks.delete(id);
    }
    for (const [id, route] of this.turnRoutes) {
      if (route.ts < cutoff) this.turnRoutes.delete(id);
    }
  }

  private reapEmptyRooms() {
    const now = Date.now();
    for (const [roomId, since] of [...this.emptyAt]) {
      if (now - since < LIMITS.emptyRoomTtlMs) continue;
      // Room may have been deleted already via the API; be defensive.
      const exists = db.prepare(`SELECT 1 FROM room WHERE id = ?`).get(roomId);
      if (exists) {
        db.prepare(`DELETE FROM room WHERE id = ?`).run(roomId);
        db.prepare(`DELETE FROM room_agent WHERE room_id = ?`).run(roomId);
        db.prepare(`DELETE FROM room_usage WHERE room_id = ?`).run(roomId);
        console.log(`[shitty-chat] reaped empty room ${roomId} (empty for ${Math.round((now - since) / 1000)}s)`);
      }
      this.emptyAt.delete(roomId);
      this.rooms.delete(roomId);
    }
  }
}
