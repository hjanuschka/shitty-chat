// shitty-chat-mcp: MCP server that connects Claude Desktop / ChatGPT
// Desktop to a shitty.chat room.
//
// The MCP server holds one WebSocket to the relay and exposes the same
// primitives as the pi extension:
//   chat_join / chat_leave / chat_status / chat_members
//   chat_ask / chat_say / chat_turn / chat_recv
//
// Incoming asks and turns are auto-declined (the client here is an LLM,
// but MCP doesn't currently give us a clean way to bubble them back
// into a Claude/ChatGPT turn). Says show up in chat_recv.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import WebSocket from "ws";
import { deriveKeys, openBlob, seal } from "../../shared/crypto.js";
import {
  AAD,
  type AskPayload,
  type AskAckPayload,
  type AskResponsePayload,
  type Envelope,
  type MemberInfo,
  type SayPayload,
  type TurnPayload,
  type TurnResponsePayload,
  type WelcomePayload,
} from "../../shared/protocol.js";

const CONFIG_DIR = join(homedir(), ".shitty-chat-mcp");
const IDENTITY_PATH = join(CONFIG_DIR, "identity.json");

const DEFAULT_RELAY = process.env.SHITTY_CHAT_RELAY_URL ?? "wss://shitty.chat/ws";
const ROOM_KEY_ENV = process.env.SHITTY_CHAT_ROOM_KEY ?? "";
const DISPLAY_NAME =
  process.env.SHITTY_CHAT_NAME ??
  `${userInfo().username}@${hostname()}:mcp`;

function loadIdentity(): string {
  try {
    if (existsSync(IDENTITY_PATH)) {
      const raw = JSON.parse(readFileSync(IDENTITY_PATH, "utf8")) as {
        secret?: string;
      };
      if (raw.secret) return raw.secret;
    }
  } catch {
    /* fall through */
  }
  mkdirSync(dirname(IDENTITY_PATH), { recursive: true });
  const secret = globalThis.crypto.randomUUID();
  writeFileSync(IDENTITY_PATH, JSON.stringify({ secret }, null, 2), "utf8");
  return secret;
}

// ---------------------------------------------------------------------------
// state

interface LogEntry {
  id: string;
  ts: number;
  kind: "ask" | "say" | "turn" | "system";
  direction: "in" | "out" | "info";
  peer: string;
  text: string;
  status: string;
  responses: Map<string, { text: string; status: string }>;
}

const identity = loadIdentity();
const log: LogEntry[] = [];
let ws: WebSocket | undefined;
let e2eKey: Uint8Array | undefined;
let roomKey: string | undefined;
let agentId = "";
let role: "master" | "slave" = "slave";
let roomName = "";
let members: MemberInfo[] = [];

function pushLog(entry: LogEntry) {
  log.push(entry);
  if (log.length > 500) log.splice(0, log.length - 500);
}

function findEntry(id: string) {
  return log.find((e) => e.id === id);
}

// ---------------------------------------------------------------------------
// WS layer

async function connect(key: string, url: string): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  roomKey = key;
  const derived = await deriveKeys(key);
  e2eKey = derived.e2eKey;

  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url);
    ws = socket;

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          payload: {
            authKey: derived.authKeyHex,
            identity,
            name: DISPLAY_NAME,
            platform: `mcp-${platform()}`,
          },
        }),
      );
    });

    socket.on("message", (data) => {
      let msg: Envelope;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === "welcome" && !settled) {
        settled = true;
        const w = msg.payload as WelcomePayload;
        agentId = w.agentId;
        role = w.role;
        roomName = w.roomName;
        members = w.members;
        pushLog({
          id: crypto.randomUUID(),
          ts: Date.now(),
          kind: "system",
          direction: "info",
          peer: "relay",
          text: `joined "${w.roomName}" as ${w.agentId} [${w.role}]`,
          status: "joined",
          responses: new Map(),
        });
        resolve();
        return;
      }
      if (msg.type === "error" && !settled) {
        settled = true;
        const p = msg.payload as { code: string; message: string };
        reject(new Error(`${p.code}: ${p.message}`));
        return;
      }
      handleServer(msg).catch((err) => {
        pushLog({
          id: crypto.randomUUID(),
          ts: Date.now(),
          kind: "system",
          direction: "info",
          peer: "relay",
          text: `error: ${err}`,
          status: "error",
          responses: new Map(),
        });
      });
    });

    socket.on("close", () => {
      if (ws === socket) ws = undefined;
      if (!settled) {
        settled = true;
        reject(new Error("connection closed before welcome"));
      }
    });

    socket.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function sendEnvelope(type: string, payload?: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
}

// ---- incoming ----

async function handleServer(msg: Envelope) {
  switch (msg.type) {
    case "member_update": {
      const p = msg.payload as { members: MemberInfo[] };
      members = p.members;
      return;
    }
    case "ask_received": {
      if (!e2eKey) return;
      const p = msg.payload as AskPayload;
      let promptText = "(decrypt failed)";
      try {
        promptText = await openBlob(e2eKey, p.prompt, AAD.ask(p.askId));
      } catch {
        /* keep placeholder */
      }
      pushLog({
        id: p.askId,
        ts: Date.now(),
        kind: "ask",
        direction: "in",
        peer: msg.from ?? "?",
        text: promptText,
        status: "declined (mcp)",
        responses: new Map(),
      });
      // Auto-decline: MCP surface is for outgoing operations.
      sendEnvelope("ask_ack", { askId: p.askId, status: "declined" });
      return;
    }
    case "turn_received": {
      if (!e2eKey) return;
      const p = msg.payload as TurnPayload;
      let promptText = "(decrypt failed)";
      try {
        promptText = await openBlob(e2eKey, p.prompt, AAD.turn(p.turnId, msg.from ?? "?"));
      } catch {
        /* keep placeholder */
      }
      pushLog({
        id: p.turnId,
        ts: Date.now(),
        kind: "turn",
        direction: "in",
        peer: msg.from ?? "?",
        text: promptText,
        status: "ignored (mcp has no LLM)",
        responses: new Map(),
      });
      return;
    }
    case "say_received": {
      if (!e2eKey) return;
      const p = msg.payload as SayPayload;
      let text = "(decrypt failed)";
      try {
        text = await openBlob(e2eKey, p.text, AAD.say(p.sayId, msg.from ?? "?"));
      } catch {
        /* keep placeholder */
      }
      pushLog({
        id: p.sayId,
        ts: Date.now(),
        kind: "say",
        direction: "in",
        peer: msg.from ?? "?",
        text,
        status: "received",
        responses: new Map(),
      });
      return;
    }
    case "ask_ack": {
      const p = msg.payload as AskAckPayload;
      const entry = findEntry(p.askId);
      if (entry) {
        const from = msg.from ?? "?";
        entry.responses.set(from, {
          text: entry.responses.get(from)?.text ?? "",
          status: p.status,
        });
      }
      return;
    }
    case "ask_response": {
      if (!e2eKey) return;
      const p = msg.payload as AskResponsePayload;
      const entry = findEntry(p.askId);
      if (!entry) return;
      const from = msg.from ?? "?";
      let text = entry.responses.get(from)?.text ?? "";
      if (p.chunk) {
        try {
          text += await openBlob(e2eKey, p.chunk, AAD.resp(p.askId, from));
        } catch {
          text += "[decrypt failed]";
        }
      }
      if (p.error) text += `[error: ${p.error}]`;
      entry.responses.set(from, { text, status: p.status });
      if (p.status === "final") entry.status = "answered";
      return;
    }
    case "turn_response": {
      if (!e2eKey) return;
      const p = msg.payload as TurnResponsePayload;
      const entry = findEntry(p.turnId);
      if (!entry) return;
      const from = msg.from ?? "?";
      let text = entry.responses.get(from)?.text ?? "";
      if (p.chunk) {
        try {
          text += await openBlob(e2eKey, p.chunk, AAD.turnResp(p.turnId, from));
        } catch {
          text += "[decrypt failed]";
        }
      }
      if (p.error) text += `[error: ${p.error}]`;
      entry.responses.set(from, { text, status: p.status });
      if (p.status === "final") entry.status = "answered";
      return;
    }
    case "bye": {
      const p = msg.payload as { reason: string };
      pushLog({
        id: crypto.randomUUID(),
        ts: Date.now(),
        kind: "system",
        direction: "info",
        peer: "relay",
        text: `disconnected by relay (${p.reason})`,
        status: p.reason,
        responses: new Map(),
      });
      ws?.close();
      return;
    }
    case "error": {
      const p = msg.payload as { code: string; message: string };
      pushLog({
        id: crypto.randomUUID(),
        ts: Date.now(),
        kind: "system",
        direction: "info",
        peer: "relay",
        text: p.message,
        status: p.code,
        responses: new Map(),
      });
      return;
    }
  }
}

// ---- outgoing helpers ----

function requireConnection() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !e2eKey) {
    throw new Error("Not connected. Call chat_join with a room key first (or set SHITTY_CHAT_ROOM_KEY).");
  }
}

function resolveTarget(target: string): string {
  if (target === "master") {
    return members.find((m) => m.role === "master")?.agentId ?? target;
  }
  if (target && target !== "all") {
    if (!members.find((m) => m.agentId === target)) {
      const online = members.filter((m) => m.agentId !== agentId).map((m) => m.agentId);
      throw new Error(
        `No agent "${target}" in this room. connected agents: ${online.join(", ") || "(none)"}`,
      );
    }
  }
  return target || "all";
}

async function outgoingAsk(
  prompt: string,
  target: string,
  withContext: boolean,
  extraContext: string | undefined,
): Promise<string> {
  requireConnection();
  const askId = globalThis.crypto.randomUUID();
  const promptBlob = await seal(e2eKey!, prompt, AAD.ask(askId));
  let contextBlob;
  if (withContext || extraContext) {
    const body =
      extraContext ??
      `[mcp context]\ndisplay name: ${DISPLAY_NAME}\nagent id: ${agentId}\n(mcp bridge - no file access)`;
    contextBlob = await seal(e2eKey!, body, AAD.ctx(askId));
  }
  const entry: LogEntry = {
    id: askId,
    ts: Date.now(),
    kind: "ask",
    direction: "out",
    peer: target,
    text: prompt,
    status: "sent",
    responses: new Map(),
  };
  pushLog(entry);
  sendEnvelope("ask", { askId, prompt: promptBlob, context: contextBlob, target, agentMode: true });

  return new Promise<string>((resolve) => {
    const expected =
      target && target !== "all"
        ? 1
        : members.filter((m) => m.agentId !== agentId && m.connected && m.state === "active").length;
    let firstAt = 0;
    const finish = () => {
      clearInterval(poll);
      clearTimeout(hard);
      if (entry.responses.size === 0) {
        resolve(`(no responses within timeout for ask ${askId.slice(0, 8)})`);
        return;
      }
      const parts: string[] = [];
      for (const [from, r] of entry.responses) {
        parts.push(`--- ${from} (${r.status}) ---\n${r.text}`);
      }
      resolve(parts.join("\n\n"));
    };
    const poll = setInterval(() => {
      const finals = [...entry.responses.values()].filter(
        (r) => r.status === "final" || r.status === "error",
      ).length;
      if (finals >= expected && expected > 0) return finish();
      if (finals > 0 && !firstAt) firstAt = Date.now();
      if (firstAt && Date.now() - firstAt > 30_000) finish();
    }, 500);
    const hard = setTimeout(finish, 300_000);
  });
}

async function outgoingTurn(prompt: string, target: string, wait: boolean): Promise<string> {
  requireConnection();
  const turnId = globalThis.crypto.randomUUID();
  const blob = await seal(e2eKey!, prompt, AAD.turn(turnId, agentId));
  sendEnvelope("turn", { turnId, prompt: blob, target });
  const entry: LogEntry = {
    id: turnId,
    ts: Date.now(),
    kind: "turn",
    direction: "out",
    peer: target,
    text: prompt,
    status: "sent",
    responses: new Map(),
  };
  pushLog(entry);

  const recipients =
    target === "all"
      ? members.filter((m) => m.connected && m.agentId !== agentId && m.state === "active").map((m) => m.agentId)
      : [target];

  if (!wait) {
    return `turn provoked on ${recipients.length} agent(s): ${recipients.join(", ")} (fire-and-forget)`;
  }

  return new Promise<string>((resolve) => {
    const expected = recipients.length || 1;
    let firstAt = 0;
    const finish = () => {
      clearInterval(poll);
      clearTimeout(hard);
      const parts: string[] = [];
      for (const [from, r] of entry.responses) {
        parts.push(`--- ${from} (${r.status}) ---\n${r.text}`);
      }
      resolve(parts.join("\n\n") || "(no responses within timeout)");
    };
    const poll = setInterval(() => {
      const finals = [...entry.responses.values()].filter(
        (r) => r.status === "final" || r.status === "error",
      ).length;
      if (finals >= expected) return finish();
      if (finals > 0 && !firstAt) firstAt = Date.now();
      if (firstAt && Date.now() - firstAt > 30_000) finish();
    }, 500);
    const hard = setTimeout(finish, 600_000);
  });
}

// ---------------------------------------------------------------------------
// MCP server

const server = new McpServer({
  name: "shitty-chat",
  version: "0.1.0",
});

server.tool(
  "chat_join",
  "Join a shitty.chat room. Reads SHITTY_CHAT_ROOM_KEY env if roomKey is omitted.",
  {
    roomKey: z.string().optional().describe("The sc_... room key. Optional if SHITTY_CHAT_ROOM_KEY is set."),
    relayUrl: z
      .string()
      .optional()
      .describe("Override relay URL (default wss://shitty.chat/ws)."),
  },
  async ({ roomKey: key, relayUrl }) => {
    const useKey = key ?? ROOM_KEY_ENV;
    if (!useKey) {
      return {
        content: [
          {
            type: "text",
            text: "No room key provided and SHITTY_CHAT_ROOM_KEY not set. Pass roomKey=sc_...",
          },
        ],
        isError: true,
      };
    }
    try {
      await connect(useKey, relayUrl ?? DEFAULT_RELAY);
      return {
        content: [
          {
            type: "text",
            text: `Joined "${roomName}" as ${agentId} [${role}]. ${members.filter((m) => m.connected).length}/${members.length} online.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Join failed: ${err instanceof Error ? err.message : err}` }],
        isError: true,
      };
    }
  },
);

server.tool("chat_leave", "Leave the room and disconnect.", {}, async () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return { content: [{ type: "text", text: "Not connected." }] };
  }
  ws.close();
  ws = undefined;
  roomKey = undefined;
  members = [];
  return { content: [{ type: "text", text: "Left the room." }] };
});

server.tool(
  "chat_status",
  "Report shitty.chat connection status (agentId, role, room, relay URL).",
  {},
  async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return { content: [{ type: "text", text: "Not connected." }] };
    }
    const online = members.filter((m) => m.connected).map((m) => m.agentId).join(", ");
    return {
      content: [
        {
          type: "text",
          text: `agentId=${agentId} role=${role} room="${roomName}" online=[${online}]`,
        },
      ],
    };
  },
);

server.tool("chat_members", "List agents currently in the room.", {}, async () => {
  requireConnection();
  const lines = members.map(
    (m) =>
      `${m.agentId}\t${m.name}\t${m.platform}\t${m.role}\t${m.state}\t${
        m.connected ? "online" : "offline"
      }${m.agentId === agentId ? "\t(me)" : ""}`,
  );
  return {
    content: [
      {
        type: "text",
        text: lines.length
          ? `agentId\tname\tplatform\trole\tstate\tonline\n${lines.join("\n")}`
          : "no members",
      },
    ],
  };
});

server.tool(
  "chat_ask",
  "Ask other agents in the room a question. They answer with an LLM call using their own current session context. Waits for replies (default up to 300s) and returns the concatenated answers.",
  {
    prompt: z.string().describe("The question or instruction for the remote agent(s)."),
    target: z
      .string()
      .default("all")
      .describe("Agent id (e.g. linux-a1f3), 'master', or 'all' to broadcast."),
    withContext: z
      .boolean()
      .default(false)
      .describe("Include a small context snippet about this MCP bridge with the ask."),
    context: z
      .string()
      .optional()
      .describe("Custom context to ship along instead of the default. Overrides withContext."),
  },
  async ({ prompt, target, withContext, context }) => {
    try {
      const resolved = resolveTarget(target);
      const text = await outgoingAsk(prompt, resolved, withContext || !!context, context);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.tool(
  "chat_say",
  "Broadcast a plain-text message to every non-muted agent in the room. No LLM call anywhere.",
  { text: z.string().describe("Message body to broadcast.") },
  async ({ text }) => {
    try {
      requireConnection();
      const sayId = globalThis.crypto.randomUUID();
      const blob = await seal(e2eKey!, text, AAD.say(sayId, agentId));
      sendEnvelope("say", { sayId, text: blob });
      pushLog({
        id: sayId,
        ts: Date.now(),
        kind: "say",
        direction: "out",
        peer: "all",
        text,
        status: "sent",
        responses: new Map(),
      });
      const recipients = members.filter((m) => m.connected && m.agentId !== agentId).map((m) => m.agentId);
      return {
        content: [
          {
            type: "text",
            text: `Broadcast delivered to ${recipients.length} agent(s): ${recipients.join(", ") || "(none)"}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.tool(
  "chat_turn",
  "Provoke a REAL user turn on other agents. LLM and tools run on their side, their session is mutated. Returns the streamed summary when wait=true (default).",
  {
    prompt: z.string().describe("Instruction to run as a user turn on the remote(s)."),
    target: z.string().default("all").describe("Agent id, 'master', or 'all'."),
    wait: z
      .boolean()
      .default(true)
      .describe("Wait for remote(s) to finish and return their summary. Set false for fire-and-forget."),
  },
  async ({ prompt, target, wait }) => {
    try {
      const resolved = resolveTarget(target);
      const text = await outgoingTurn(prompt, resolved, wait);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.tool(
  "chat_recv",
  "Return recent room activity (broadcasts, replies, and system events) so you know what other agents said.",
  {
    limit: z.number().int().min(1).max(200).default(30).describe("How many recent entries to return."),
  },
  async ({ limit }) => {
    const slice = log.slice(-limit);
    const rows = slice.map((entry) => {
      const arrow = entry.direction === "out" ? "->" : entry.direction === "in" ? "<-" : "*";
      let out = `[${new Date(entry.ts).toISOString()}] ${arrow} ${entry.peer} [${entry.kind.toUpperCase()}] (${entry.status})\n    ${entry.text.replace(/\n/g, " ").slice(0, 400)}`;
      for (const [from, r] of entry.responses) {
        out += `\n    <- ${from} [${r.status}]\n      ${r.text.replace(/\n/g, " ").slice(0, 400)}`;
      }
      return out;
    });
    return {
      content: [{ type: "text", text: rows.join("\n\n") || "(no activity yet)" }],
    };
  },
);

// ---------------------------------------------------------------------------
// boot

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Auto-join if env var is set.
  if (ROOM_KEY_ENV) {
    connect(ROOM_KEY_ENV, DEFAULT_RELAY).catch((err) => {
      process.stderr.write(`[shitty-chat-mcp] auto-join failed: ${err}\n`);
    });
  }
  process.stderr.write(
    `[shitty-chat-mcp] ready. identity=${identity.slice(0, 8)}... display="${DISPLAY_NAME}" relay=${DEFAULT_RELAY}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[shitty-chat-mcp] fatal: ${err}\n`);
  process.exit(1);
});
