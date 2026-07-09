// shitty-chat: E2E encrypted cross-machine chat/delegation between pi agents.
//
// /chat_join <roomKey> [relayUrl]   join a room (key from shitty.chat dashboard)
// /chat_ask [@agent] <prompt>       ask others using THEIR session context
// /chat_ask_with_context [@agent] <prompt>   ...and ship MY context along
//
// All content is AES-256-GCM encrypted with a key derived from the room key.
// The relay only ever sees ciphertext.

import { complete } from "@earendil-works/pi-ai/compat";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { hostname, platform as osPlatform, userInfo } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import WebSocket from "ws";
import { deriveKeys, openBlob, seal } from "../shared/crypto";
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
} from "../shared/protocol";

// ---------------------------------------------------------------------------
// config + identity

// SHITTY_CHAT_DIR override lets tests (and multi-agent setups on one
// machine) use isolated config/identity directories.
const CONFIG_DIR =
  process.env.SHITTY_CHAT_DIR ??
  join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".pi", "agent", "shitty-chat");

interface Config {
  relayUrl: string;
  roomKey?: string;
  askPolicy: "confirm" | "auto" | "allowlist";
  answerMode: "readonly" | "agent";
  allowlist: string[];
  autoConnect: boolean;
}

const DEFAULT_CONFIG: Config = {
  // Default to the public relay at shitty.chat. Override via /chat_config,
  // by passing a URL to /chat_join, or by editing
  // ~/.pi/agent/shitty-chat/config.json.
  relayUrl: "wss://shitty.chat/ws",
  askPolicy: "confirm",
  answerMode: "readonly",
  allowlist: [],
  autoConnect: false,
};

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function loadConfig(): Config {
  return { ...DEFAULT_CONFIG, ...readJson<Partial<Config>>(join(CONFIG_DIR, "config.json")) };
}

function saveConfig(config: Config) {
  writeJson(join(CONFIG_DIR, "config.json"), config);
}

function loadIdentity(): string {
  const path = join(CONFIG_DIR, "identity.json");
  const existing = readJson<{ secret: string }>(path);
  let secret = existing?.secret;
  if (!secret) {
    secret = globalThis.crypto.randomUUID();
    writeJson(path, { secret });
  }
  // Scope identity to the working directory so multiple pi processes on the
  // same machine (different projects) appear as distinct agents.
  return `${secret}|${process.cwd()}`;
}

// ---------------------------------------------------------------------------
// session context extraction (for readonly answers + context bundles)

type SessionEntryLike = {
  type: string;
  message?: { role?: string; content?: unknown };
};

function extractText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object") {
      const block = part as { type?: string; text?: string; name?: string; arguments?: unknown };
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      if (block.type === "toolCall" && typeof block.name === "string") {
        parts.push(`[tool call: ${block.name} ${JSON.stringify(block.arguments ?? {}).slice(0, 300)}]`);
      }
    }
  }
  return parts;
}

function buildConversationText(entries: SessionEntryLike[], maxChars = 60_000): string {
  const sections: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
    const texts = extractText(entry.message.content);
    if (texts.length === 0) continue;
    const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : "ToolResult";
    let body = texts.join("\n").trim();
    if (role === "toolResult" && body.length > 2000) {
      body = `${body.slice(0, 2000)}\n[...tool output truncated]`;
    }
    if (body) sections.push(`${label}: ${body}`);
  }
  let text = sections.join("\n\n");
  if (text.length > maxChars) {
    text = `[...earlier conversation truncated]\n\n${text.slice(text.length - maxChars)}`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// ask log (drives pane/widget)

interface AskEntry {
  askId: string;
  direction: "out" | "in";
  peer: string; // target or sender
  prompt: string;
  status: string;
  responses: Map<string, { text: string; status: string }>;
  ts: number;
}

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let config = loadConfig();
  const identity = loadIdentity();

  let ws: WebSocket | undefined;
  let e2eKey: Uint8Array | undefined;
  let roomKey: string | undefined;
  let agentId = "";
  let role = "slave";
  let roomName = "";
  let members: MemberInfo[] = [];
  let intentionalClose = false;
  let reconnectDelay = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const askLog: AskEntry[] = [];
  let answering = false;
  // What the current pending sendUserMessage-based response should be reported back as.
  let pendingRemoteAction:
    | { kind: "ask"; askId: string; from: string }
    | { kind: "turn"; turnId: string; from: string }
    | undefined;
  // Session-level accept/deny cache so we don't nag the user for every
  // message from an agent they already trusted this session.
  const sessionTrusted = new Set<string>();
  const sessionBlocked = new Set<string>();
  // set while /chat_window overlay is open; called on any askLog mutation
  let chatWindowInvalidate: (() => void) | undefined;
  const notifyChatWindow = () => chatWindowInvalidate?.();

  async function consentFor(
    kind: "ask" | "turn",
    from: string,
    preview: string,
    ctx: ExtensionContext | undefined,
    extraNote?: string,
  ): Promise<boolean> {
    if (sessionBlocked.has(from)) return false;
    if (sessionTrusted.has(from)) return true;
    if (config.askPolicy === "auto") return true;
    if (config.askPolicy === "allowlist" && config.allowlist.includes(from)) return true;
    if (!ctx?.hasUI) return false;
    const label = kind === "turn" ? "REAL TURN (LLM + tools)" : "answer with your context";
    const choice = await ctx.ui.select(
      `chat ${kind} from ${from} - ${label}${extraNote ? ` (${extraNote})` : ""}`,
      [
        "accept",
        "accept + trust this session (no more prompts from this agent)",
        "decline",
        "decline + block this session",
      ],
    );
    if (!choice) return false;
    if (choice.startsWith("accept + trust")) sessionTrusted.add(from);
    if (choice.startsWith("decline + block")) sessionBlocked.add(from);
    return choice.startsWith("accept");
  }

  let lastCtx: ExtensionContext | undefined;

  const displayName = `${userInfo().username}@${hostname()}:${basename(process.cwd())}`;

  // ---- ui helpers ----

  // notifyAlways = always shows (user-initiated command results, errors,
  //                consent-related). notify = passive/background chatter,
  //                only shown when the /chat_window overlay is open, so a
  //                pi in an unrelated session doesn't get spammed.
  const notifyAlways = (msg: string, level: "info" | "warning" | "error" = "info") => {
    if (lastCtx?.hasUI) lastCtx.ui.notify(msg, level);
  };
  const chatVisible = () => chatWindowInvalidate !== undefined;
  const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
    // Suppress passive chatter only in interactive TUI mode and only when the
    // /chat_window overlay is not open. RPC / print / json modes still get
    // every notification so scripts and integrations can observe events.
    if (level === "error" || chatVisible() || lastCtx?.mode !== "tui") {
      notifyAlways(msg, level);
    }
  };

  const updateStatus = () => {
    if (!lastCtx?.hasUI) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      lastCtx.ui.setStatus("shitty-chat", roomKey ? "chat: reconnecting..." : undefined);
      return;
    }
    const online = members.filter((m) => m.connected).length;
    lastCtx.ui.setStatus(
      "shitty-chat",
      `chat: ${agentId} [${role}] | ${roomName} (${online}) [e2e]`,
    );
  };

  const updateWidget = () => {
    if (!lastCtx?.hasUI) return;
    // Only paint the below-editor widget when the chat window is open, so a
    // pi that just happens to be in a room doesn't have a live activity
    // strip permanently glued to its editor.
    if (!chatVisible() || askLog.length === 0) {
      lastCtx.ui.setWidget("shitty-chat", undefined);
      notifyChatWindow();
      return;
    }
    const lines: string[] = [];
    for (const entry of askLog.slice(-4)) {
      const arrow = entry.direction === "out" ? "->" : "<-";
      lines.push(
        `${arrow} ${entry.peer} [${entry.status}] ${entry.prompt.slice(0, 60).replace(/\n/g, " ")}`,
      );
      for (const [from, resp] of entry.responses) {
        const preview = resp.text.replace(/\n/g, " ").slice(0, 70);
        lines.push(`   ${from}: ${preview}${resp.text.length > 70 ? "..." : ""}`);
      }
    }
    lastCtx.ui.setWidget("shitty-chat", lines.slice(-10), { placement: "belowEditor" });
    notifyChatWindow();
  };

  const findAsk = (askId: string) => askLog.find((e) => e.askId === askId);

  // ---- ws client ----

  const sendEnvelope = (type: string, payload?: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
  };

  const disconnect = () => {
    intentionalClose = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
    ws = undefined;
    members = [];
    updateStatus();
  };

  const connect = async (key: string, url: string): Promise<void> => {
    disconnect();
    intentionalClose = false;
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
              name: displayName,
              platform: osPlatform(),
            },
          }),
        );
      });

      socket.on("message", (data: unknown) => {
        let msg: Envelope;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg.type === "welcome" && !settled) {
          settled = true;
          reconnectDelay = 1000;
          const w = msg.payload as WelcomePayload;
          agentId = w.agentId;
          role = w.role;
          roomName = w.roomName;
          members = w.members;
          updateStatus();
          resolve();
          return;
        }
        if (msg.type === "error" && !settled) {
          settled = true;
          const p = msg.payload as { code: string; message: string };
          reject(new Error(`${p.code}: ${p.message}`));
          return;
        }
        handleServerMessage(msg).catch((err) => notify(`chat error: ${err}`, "error"));
      });

      socket.on("close", () => {
        if (ws === socket) ws = undefined;
        updateStatus();
        if (!settled) {
          settled = true;
          reject(new Error("connection closed"));
          return;
        }
        if (!intentionalClose && roomKey) {
          reconnectTimer = setTimeout(() => {
            connect(roomKey!, config.relayUrl).catch(() => {});
          }, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        }
      });

      socket.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  };

  // ---- incoming messages ----

  async function handleServerMessage(msg: Envelope) {
    switch (msg.type) {
      case "member_update": {
        const p = msg.payload as { event: string; agentId?: string; members: MemberInfo[] };
        members = p.members;
        updateStatus();
        if (p.event === "join" && p.agentId && p.agentId !== agentId) {
          notify(`chat: ${p.agentId} joined ${roomName}`);
        }
        if (p.event === "leave" && p.agentId) notify(`chat: ${p.agentId} left`);
        return;
      }
      case "ask_received":
        await handleAskReceived(msg.from ?? "?", msg.payload as AskPayload);
        return;
      case "say_received":
        await handleSayReceived(msg.from ?? "?", msg.payload as SayPayload);
        return;
      case "turn_received":
        await handleTurnReceived(msg.from ?? "?", msg.payload as TurnPayload);
        return;
      case "turn_response":
        await handleTurnResponse(msg.from ?? "?", msg.payload as TurnResponsePayload);
        return;
      case "ask_ack": {
        const p = msg.payload as AskAckPayload;
        const entry = findAsk(p.askId);
        if (entry) {
          entry.responses.set(msg.from ?? "?", {
            text: entry.responses.get(msg.from ?? "?")?.text ?? "",
            status: p.status,
          });
          // Only surface non-accepted ack toasts for TARGETED asks. For
          // broadcasts (target === "all") the receivers that can't or won't
          // answer (browser participants, muted agents) just drop out; the
          // pane still shows the [declined]/[busy] state per responder.
          const wasTargeted = entry.direction === "out" && entry.peer !== "all";
          if (p.status !== "accepted" && wasTargeted) {
            notify(`chat: ${msg.from} ${p.status}`, "warning");
          }
          updateWidget();
        }
        return;
      }
      case "ask_response": {
        const p = msg.payload as AskResponsePayload;
        const entry = findAsk(p.askId);
        if (!entry || !e2eKey) return;
        const from = msg.from ?? "?";
        let text = entry.responses.get(from)?.text ?? "";
        if (p.chunk) {
          try {
            text += await openBlob(e2eKey, p.chunk, AAD.resp(p.askId, from));
          } catch {
            text += "[decryption failed - key mismatch?]";
          }
        }
        if (p.error) text += `[error: ${p.error}]`;
        entry.responses.set(from, { text, status: p.status });
        if (p.status === "final") {
          entry.status = "answered";
          const preview = text.replace(/\s+/g, " ").slice(0, 200);
          notify(`chat: response from ${from}: ${preview}${text.length > 200 ? "... (see /chat_pane)" : ""}`);
        }
        updateWidget();
        return;
      }
      case "bye": {
        const p = msg.payload as { reason: string };
        notify(`chat: disconnected (${p.reason})`, "warning");
        intentionalClose = true;
        roomKey = undefined;
        updateStatus();
        return;
      }
      case "error": {
        const p = msg.payload as { code: string; message: string };
        notify(`chat: ${p.code}: ${p.message}`, "warning");
        return;
      }
    }
  }

  // ---- incoming turn responses (I provoked a turn; here comes the summary) ----

  async function handleTurnResponse(from: string, payload: TurnResponsePayload) {
    const entry = findAsk(payload.turnId);
    if (!entry || !e2eKey) return;
    let text = entry.responses.get(from)?.text ?? "";
    if (payload.chunk) {
      try {
        text += await openBlob(e2eKey, payload.chunk, AAD.turnResp(payload.turnId, from));
      } catch {
        text += "[decryption failed - key mismatch?]";
      }
    }
    if (payload.error) text += `[error: ${payload.error}]`;
    entry.responses.set(from, { text, status: payload.status });
    if (payload.status === "final") {
      entry.status = "answered";
      const preview = text.replace(/\s+/g, " ").slice(0, 200);
      notify(`chat: turn done on ${from}: ${preview}${text.length > 200 ? "..." : ""}`);
    } else if (payload.status === "error") {
      entry.status = "error";
    }
    updateWidget();
  }

  // ---- incoming remote-provoked turns ----

  async function handleTurnReceived(from: string, payload: TurnPayload) {
    if (!e2eKey) return;
    let prompt: string;
    try {
      prompt = await openBlob(e2eKey, payload.prompt, AAD.turn(payload.turnId, from));
    } catch {
      notify("chat: could not decrypt incoming turn (key mismatch?)", "error");
      return;
    }
    const entry: AskEntry = {
      askId: payload.turnId,
      direction: "in",
      peer: from,
      prompt: `[turn] ${prompt}`,
      status: "pending",
      responses: new Map(),
      ts: Date.now(),
    };
    askLog.push(entry);
    updateWidget();

    const accepted = await consentFor("turn", from, prompt.slice(0, 500), lastCtx);
    if (!accepted) {
      entry.status = "declined";
      updateWidget();
      notify(`chat: declined turn from ${from}`, "warning");
      if (e2eKey) {
        // Tell the provoker we bailed so their UI can move on.
        const chunk = await seal(e2eKey, `(declined)`, AAD.turnResp(payload.turnId, agentId));
        sendEnvelope("turn_response", {
          turnId: payload.turnId,
          toAgentId: from,
          status: "error",
          chunk,
          error: "declined",
        });
      }
      return;
    }
    entry.status = "running";
    updateWidget();
    notify(`chat: running turn from ${from}`);
    answering = true;
    pendingRemoteAction = { kind: "turn", turnId: payload.turnId, from };
    await streamEvent({ kind: "start", agentId, action: "turn" });
    const framed = `[shitty-chat: turn from ${from}]\n\n${prompt}`;
    if (lastCtx?.isIdle()) {
      pi.sendUserMessage(framed);
    } else {
      pi.sendUserMessage(framed, { deliverAs: "followUp" });
    }
  }

  // ---- incoming broadcast "say" messages ----

  async function handleSayReceived(from: string, payload: SayPayload) {
    if (!e2eKey) return;
    let text: string;
    try {
      text = await openBlob(e2eKey, payload.text, AAD.say(payload.sayId, from));
    } catch {
      notify("chat: could not decrypt broadcast (key mismatch?)", "error");
      return;
    }
    const entry: AskEntry = {
      askId: payload.sayId,
      direction: "in",
      peer: from,
      prompt: `[broadcast] ${text}`,
      status: "say",
      responses: new Map(),
      ts: Date.now(),
    };
    askLog.push(entry);
    updateWidget();
    notify(`chat: ${from} says: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
  }

  // ---- answering incoming asks ----

  async function handleAskReceived(from: string, payload: AskPayload) {
    if (!e2eKey) return;
    let prompt: string;
    let context: string | undefined;
    try {
      prompt = await openBlob(e2eKey, payload.prompt, AAD.ask(payload.askId));
      if (payload.context) {
        context = await openBlob(e2eKey, payload.context, AAD.ctx(payload.askId));
      }
    } catch {
      notify("chat: could not decrypt incoming ask (key mismatch?)", "error");
      return;
    }

    const entry: AskEntry = {
      askId: payload.askId,
      direction: "in",
      peer: from,
      prompt,
      status: "pending",
      responses: new Map(),
      ts: Date.now(),
    };
    askLog.push(entry);
    updateWidget();

    if (answering) {
      sendEnvelope("ask_ack", { askId: payload.askId, status: "busy" });
      entry.status = "busy";
      updateWidget();
      return;
    }

    const wantsAgentMode = payload.agentMode === true && config.answerMode === "agent";
    const accepted = await consentFor(
      "ask",
      from,
      prompt.slice(0, 500),
      lastCtx,
      wantsAgentMode ? "AGENT MODE" : "readonly",
    );

    if (!accepted) {
      sendEnvelope("ask_ack", { askId: payload.askId, status: "declined" });
      entry.status = "declined";
      updateWidget();
      return;
    }

    sendEnvelope("ask_ack", { askId: payload.askId, status: "accepted" });
    entry.status = "answering";
    answering = true;
    updateWidget();

    try {
      if (wantsAgentMode) {
        await answerAgentMode(payload.askId, from, prompt, context);
      } else {
        await answerReadonly(payload.askId, from, prompt, context);
        entry.status = "answered";
        answering = false;
      }
    } catch (err) {
      answering = false;
      entry.status = "error";
      sendEnvelope("ask_response", {
        askId: payload.askId,
        toAgentId: from,
        status: "error",
        error: String(err).slice(0, 300),
      });
    }
    updateWidget();
  }

  async function sendEncryptedResponse(
    askId: string,
    toAgentId: string,
    text: string,
    status: "final" | "running" = "final",
  ) {
    if (!e2eKey) return;
    const chunk = await seal(e2eKey, text, AAD.resp(askId, agentId));
    sendEnvelope("ask_response", { askId, toAgentId, status, chunk });
  }

  // Live progress streaming while I'm executing a remote-provoked action.
  // Sends tool-call events (and text bursts) as `running` chunks so the
  // provoker sees progress instead of a blank "running" state.
  async function sendRunningChunk(text: string) {
    if (!pendingRemoteAction || !e2eKey) return;
    const action = pendingRemoteAction;
    if (action.kind === "ask") {
      const chunk = await seal(e2eKey, text, AAD.resp(action.askId, agentId));
      sendEnvelope("ask_response", {
        askId: action.askId,
        toAgentId: action.from,
        status: "running",
        chunk,
      });
    } else {
      const chunk = await seal(e2eKey, text, AAD.turnResp(action.turnId, agentId));
      sendEnvelope("turn_response", {
        turnId: action.turnId,
        toAgentId: action.from,
        status: "running",
        chunk,
      });
    }
  }

  const truncateArg = (s: unknown, n = 200) => {
    const str = typeof s === "string" ? s : JSON.stringify(s);
    if (!str) return "";
    return str.length > n ? `${str.slice(0, n)}...` : str;
  };

  // Emit a structured event that the browser (or the pi chat window) can
  // parse and render as a tool card. Enclosed in @@sc-evt:...@@ markers so
  // Streamdown treats it as plain text and we can split on it cheaply.
  const streamEvent = async (obj: object) => {
    await sendRunningChunk(`\n@@sc-evt:${JSON.stringify(obj)}@@\n`).catch(() => {});
  };

  pi.on("tool_execution_start", async (event) => {
    if (!pendingRemoteAction) return;
    const args = event.args as Record<string, unknown> | undefined;
    let arg = "";
    if (args) {
      if (typeof args.command === "string") arg = args.command;
      else if (typeof args.path === "string") arg = args.path;
      else if (typeof args.pattern === "string") arg = args.pattern;
      else if (typeof args.url === "string") arg = args.url;
      else arg = JSON.stringify(args);
    }
    await streamEvent({
      kind: "tool_start",
      toolCallId: event.toolCallId,
      name: event.toolName ?? "tool",
      arg: truncateArg(arg, 400),
    });
  });

  pi.on("tool_execution_end", async (event) => {
    if (!pendingRemoteAction) return;
    // Capture full output so the browser can offer an expand/collapse.
    // Cap at 3000 chars for wire size; anything longer is truncated.
    const content = (event.result as { content?: Array<{ text?: string }> })?.content;
    const rawOutput = content?.map((c) => c?.text ?? "").join("").trim() ?? "";
    const output = rawOutput.length > 3000 ? `${rawOutput.slice(0, 3000)}\n\n... (${rawOutput.length - 3000} more chars truncated)` : rawOutput;
    await streamEvent({
      kind: "tool_end",
      toolCallId: event.toolCallId,
      name: event.toolName ?? "tool",
      error: !!event.isError,
      summary: event.isError ? truncateArg(rawOutput, 200) : "",
      output,
    });
  });

  // Stream assistant text between tool calls (so the user sees the model's
  // reasoning + narration as it emits it, not just the final answer).
  pi.on("message_end", async (event) => {
    if (!pendingRemoteAction) return;
    const msg = event.message as { role?: string; content?: unknown };
    if (msg.role !== "assistant") return;
    const text = extractText(msg.content)
      .filter((t) => !t.startsWith("[tool call:"))
      .join("\n")
      .trim();
    if (text) await sendRunningChunk(`${text}\n\n`).catch(() => {});
  });

  async function answerReadonly(askId: string, from: string, prompt: string, context?: string) {
    const ctx = lastCtx;
    if (!ctx) throw new Error("no session context available");

    const model = ctx.model;
    if (!model) throw new Error("no model configured on this agent");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) throw new Error("no API key available on this agent");

    const convo = buildConversationText(ctx.sessionManager.getBranch() as SessionEntryLike[]);
    const parts = [
      `You are a pi coding agent ("${agentId}") on ${osPlatform()} in ${ctx.cwd}.`,
      `Another agent ("${from}") in your shared room asked you a question.`,
      `Answer it using your current working context below. Be concise and specific.`,
      "",
    ];
    if (context) {
      parts.push("<asking_agent_context>", context, "</asking_agent_context>", "");
    }
    if (convo.trim()) {
      parts.push("<my_current_session>", convo, "</my_current_session>", "");
    }
    parts.push(`Question from ${from}: ${prompt}`);

    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: parts.join("\n") }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
    );

    const text = response.content
      .filter((c: { type: string }): c is { type: "text"; text: string } => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("\n");

    await sendEncryptedResponse(askId, from, text || "(empty response)");
  }

  async function answerAgentMode(askId: string, from: string, prompt: string, context?: string) {
    // Runs a REAL tool-using turn in this session (visible to the local user).
    pendingRemoteAction = { kind: "ask", askId, from };
    await streamEvent({ kind: "start", agentId, action: "ask" });
    const framed = [
      `[shitty-chat] Agent "${from}" asked you to do the following. Execute it and`,
      `summarize the outcome clearly at the end.`,
      "",
      context ? `Context from ${from}:\n${context}\n` : "",
      `Task: ${prompt}`,
    ]
      .filter(Boolean)
      .join("\n");

    if (lastCtx?.isIdle()) {
      pi.sendUserMessage(framed);
    } else {
      pi.sendUserMessage(framed, { deliverAs: "followUp" });
    }
  }

  pi.on("agent_end", async () => {
    if (!pendingRemoteAction) return;
    const action = pendingRemoteAction;
    pendingRemoteAction = undefined;
    answering = false;

    const entry = findAsk(action.kind === "ask" ? action.askId : action.turnId);
    if (entry) entry.status = "answered";
    // Everything we wanted to say has already streamed via message_end +
    // tool_execution_* running chunks. Send an empty final chunk just to
    // flip the sender-side status to answered.
    if (action.kind === "ask") {
      await sendEncryptedResponse(action.askId, action.from, "");
    } else if (e2eKey) {
      const chunk = await seal(e2eKey, "", AAD.turnResp(action.turnId, agentId));
      sendEnvelope("turn_response", {
        turnId: action.turnId,
        toAgentId: action.from,
        status: "final",
        chunk,
      });
    }
    updateWidget();
  });

  // ---- outgoing asks ----

  async function sendAsk(args: string, withContext: boolean, ctx: ExtensionContext) {
    lastCtx = ctx;
    if (!ws || ws.readyState !== WebSocket.OPEN || !e2eKey) {
      notify("chat: not connected. use /chat_join <roomKey> first", "error");
      return;
    }
    let target = "all";
    let prompt = args.trim();
    const targetMatch = prompt.match(/^@(\S+)\s+(.*)$/s);
    if (targetMatch) {
      target = targetMatch[1] === "master"
        ? members.find((m) => m.role === "master")?.agentId ?? targetMatch[1]
        : targetMatch[1];
      prompt = targetMatch[2];
    }
    if (!prompt) {
      notify("usage: /chat_ask [@agentId] <prompt>", "warning");
      return;
    }

    const askId = globalThis.crypto.randomUUID();
    let contextBlob;
    if (withContext) {
      const bundle = await buildContextBundle(ctx);
      contextBlob = await seal(e2eKey, bundle, AAD.ctx(askId));
    }
    const promptBlob = await seal(e2eKey, prompt, AAD.ask(askId));

    const entry: AskEntry = {
      askId,
      direction: "out",
      peer: target,
      prompt,
      status: "sent",
      responses: new Map(),
      ts: Date.now(),
    };
    askLog.push(entry);

    sendEnvelope("ask", {
      askId,
      prompt: promptBlob,
      context: contextBlob,
      target,
      agentMode: true, // remote decides based on its own answerMode setting
    });
    updateWidget();
    notifyAlways(`chat: asked ${target === "all" ? "the room" : target}`);

    setTimeout(() => {
      if (entry.status === "sent") {
        entry.status = "timeout";
        updateWidget();
      }
    }, 300_000);
  }

  async function buildContextBundle(ctx: ExtensionContext): Promise<string> {
    const parts: string[] = [
      `platform: ${osPlatform()}`,
      `cwd: ${ctx.cwd}`,
      `agent: ${agentId} (${displayName})`,
    ];
    try {
      const branch = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 5000 });
      if (branch.code === 0) parts.push(`git branch: ${branch.stdout.trim()}`);
      const status = await pi.exec("git", ["status", "--short"], { timeout: 5000 });
      if (status.code === 0 && status.stdout.trim()) {
        parts.push(`git status:\n${status.stdout.trim().slice(0, 2000)}`);
      }
      const diff = await pi.exec("git", ["diff", "--stat"], { timeout: 5000 });
      if (diff.code === 0 && diff.stdout.trim()) {
        parts.push(`git diff --stat:\n${diff.stdout.trim().slice(0, 2000)}`);
      }
    } catch {
      // not a git repo, fine
    }
    const convo = buildConversationText(ctx.sessionManager.getBranch() as SessionEntryLike[], 80_000);
    if (convo.trim()) parts.push(`recent session:\n${convo}`);
    return parts.join("\n\n");
  }

  // ---- commands ----

  const requireConnection = (ctx: ExtensionContext): boolean => {
    lastCtx = ctx;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      notify("chat: not connected", "error");
      return false;
    }
    return true;
  };

  pi.registerCommand("chat_join", {
    description: "Join a shitty.chat room: /chat_join <roomKey> [relayUrl]",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const key = parts[0] ?? config.roomKey;
      if (!key) {
        notify("usage: /chat_join <roomKey> [relayUrl]", "warning");
        return;
      }
      if (parts[1]) {
        config.relayUrl = parts[1];
        saveConfig(config);
      }
      try {
        await connect(key, config.relayUrl);
        notifyAlways(`chat: joined "${roomName}" as ${agentId} [${role}]`);
        if (!config.roomKey && ctx.hasUI) {
          const save = await ctx.ui.confirm(
            "Save room key?",
            "Store the room key in plaintext in ~/.pi/agent/shitty-chat/config.json so this agent can auto-rejoin?",
          );
          if (save) {
            config.roomKey = key;
            config.autoConnect = true;
            saveConfig(config);
          }
        }
      } catch (err) {
        notify(`chat: join failed: ${err instanceof Error ? err.message : err}`, "error");
      }
    },
  });

  pi.registerCommand("chat_leave", {
    description: "Leave the chat room and disconnect",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      disconnect();
      roomKey = undefined;
      if (config.roomKey) {
        config.roomKey = undefined;
        config.autoConnect = false;
        saveConfig(config);
      }
      notifyAlways("chat: left");
    },
  });

  pi.registerCommand("chat_status", {
    description: "Show chat connection status",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        notifyAlways("chat: not connected");
        return;
      }
      const online = members.filter((m) => m.connected);
      notifyAlways(
        `chat: ${agentId} [${role}] in "${roomName}" | relay ${config.relayUrl} | ` +
          `online: ${online.map((m) => m.agentId).join(", ")} | ` +
          `policy: ${config.askPolicy}, mode: ${config.answerMode}`,
      );
    },
  });

  pi.registerCommand("chat_members", {
    description: "List room members",
    handler: async (_args, ctx) => {
      if (!requireConnection(ctx)) return;
      sendEnvelope("room_members");
      const lines = members.map(
        (m) =>
          `${m.agentId} [${m.role}] ${m.platform} ${m.state}${m.connected ? "" : " (offline)"}${m.agentId === agentId ? " (me)" : ""}`,
      );
      notifyAlways(lines.join("\n") || "no members");
    },
  });

  const memberCompletions = (prefix: string) => {
    const items = members
      .filter((m) => m.agentId !== agentId)
      .map((m) => ({ value: m.agentId, label: m.agentId, description: m.name }));
    const filtered = items.filter((i) => i.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  };

  for (const [cmd, type] of [
    ["chat_kick", "room_kick"],
    ["chat_ban", "room_ban"],
    ["chat_unban", "room_unban"],
    ["chat_mute", "room_mute"],
    ["chat_unmute", "room_unmute"],
  ] as const) {
    pi.registerCommand(cmd, {
      description: `${cmd.replace("chat_", "")} an agent (master only): /${cmd} <agentId>`,
      getArgumentCompletions: memberCompletions,
      handler: async (args, ctx) => {
        if (!requireConnection(ctx)) return;
        const target = (args ?? "").trim();
        if (!target) {
          notify(`usage: /${cmd} <agentId>`, "warning");
          return;
        }
        sendEnvelope(type, { targetAgentId: target });
      },
    });
  }

  pi.registerCommand("chat_turn", {
    description:
      "Remote-provoke a REAL user turn on other agents: /chat_turn [@agentId] <prompt> (broadcasts if no @)",
    getArgumentCompletions: (prefix) =>
      prefix.startsWith("@") ? memberCompletions(prefix.slice(1)) : null,
    handler: async (args, ctx) => {
      if (!requireConnection(ctx)) return;
      if (!e2eKey) return;
      let text = (args ?? "").trim();
      let target = "all";
      const targetMatch = text.match(/^@(\S+)\s+(.*)$/s);
      if (targetMatch) {
        target = targetMatch[1] === "master"
          ? members.find((m) => m.role === "master")?.agentId ?? targetMatch[1]
          : targetMatch[1];
        text = targetMatch[2];
      }
      if (!text) {
        notify("usage: /chat_turn [@agentId] <prompt>", "warning");
        return;
      }
      const turnId = globalThis.crypto.randomUUID();
      const blob = await seal(e2eKey, text, AAD.turn(turnId, agentId));
      sendEnvelope("turn", { turnId, prompt: blob, target });
      const entry: AskEntry = {
        askId: turnId,
        direction: "out",
        peer: target,
        prompt: `[turn] ${text}`,
        status: "sent",
        responses: new Map(),
        ts: Date.now(),
      };
      askLog.push(entry);
      updateWidget();
      const recipients = target === "all"
        ? members.filter((m) => m.connected && m.agentId !== agentId && m.state === "active").length
        : 1;
      notifyAlways(`chat: turn provoked on ${target === "all" ? `${recipients} agent(s)` : target}`);
    },
  });

  pi.registerCommand("chat_say", {
    description: "Broadcast a plain message to everyone in the room (no LLM call): /chat_say <message>",
    handler: async (args, ctx) => {
      if (!requireConnection(ctx)) return;
      if (!e2eKey) return;
      const text = (args ?? "").trim();
      if (!text) {
        notify("usage: /chat_say <message>", "warning");
        return;
      }
      const sayId = globalThis.crypto.randomUUID();
      const blob = await seal(e2eKey, text, AAD.say(sayId, agentId));
      sendEnvelope("say", { sayId, text: blob });
      const entry: AskEntry = {
        askId: sayId,
        direction: "out",
        peer: "all",
        prompt: `[broadcast] ${text}`,
        status: "sent",
        responses: new Map(),
        ts: Date.now(),
      };
      askLog.push(entry);
      updateWidget();
      notify(`chat: broadcast sent to room (${members.filter((m) => m.connected && m.agentId !== agentId).length} recipients)`);
    },
  });

  pi.registerCommand("chat_ask", {
    description: "Ask room agents using THEIR context: /chat_ask [@agentId] <prompt>",
    getArgumentCompletions: (prefix) =>
      prefix.startsWith("@") ? memberCompletions(prefix.slice(1)) : null,
    handler: async (args, ctx) => sendAsk(args ?? "", false, ctx),
  });

  pi.registerCommand("chat_ask_with_context", {
    description: "Ask and ship MY session context along: /chat_ask_with_context [@agentId] <prompt>",
    getArgumentCompletions: (prefix) =>
      prefix.startsWith("@") ? memberCompletions(prefix.slice(1)) : null,
    handler: async (args, ctx) => sendAsk(args ?? "", true, ctx),
  });

  pi.registerCommand("chat_window", {
    description: "Open a floating chat window showing live activity in the room",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      if (ctx.mode !== "tui") {
        notify("/chat_window needs interactive mode", "warning");
        return;
      }
      if (chatWindowInvalidate) {
        notify("chat window already open (esc to close)", "info");
        return;
      }
      await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => {
          let scroll = 0;
          const container = new Container();

          const fmtTime = (ts: number) => {
            const d = new Date(ts);
            return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
          };

          const stateColor = (state: string): "success" | "warning" | "error" | "muted" | "accent" => {
            if (state === "answered" || state === "final") return "success";
            if (state === "say" || state === "sent") return "accent";
            if (state === "error" || state === "declined" || state === "timeout") return "error";
            if (state === "pending" || state === "answering" || state === "running") return "warning";
            return "muted";
          };

          const kindBadge = (prompt: string) => {
            if (prompt.startsWith("[broadcast]")) return theme.fg("accent", theme.bold(" SAY  "));
            if (prompt.startsWith("[turn]")) return theme.fg("warning", theme.bold(" TURN "));
            return theme.fg("toolTitle", theme.bold(" ASK  "));
          };

          // Left gutter char makes the overlay read like a bordered panel
          // even though we only paint top/bottom rules via DynamicBorder.
          const gutter = theme.fg("borderMuted", "\u2502 ");
          const line = (body: string) => new Text(gutter + body, 1, 0);

          const rebuild = () => {
            container.clear();

            // top rule (accent)
            container.addChild(
              new DynamicBorder((s: string) => theme.fg("borderAccent", s)),
            );

            // title row
            const connected = ws && ws.readyState === WebSocket.OPEN;
            const dot = connected ? theme.fg("success", "\u25CF") : theme.fg("error", "\u25CF");
            const title = theme.bold(theme.fg("accent", "shitty.chat"));
            const meta = connected
              ? theme.fg("muted",
                  `  ${roomName}  \u00B7  ${agentId} [${role}]  \u00B7  ${members.filter((m) => m.connected).length}/${members.filter((m) => m.state !== "banned").length} online`)
              : theme.fg("muted", "  not connected");
            container.addChild(line(`${dot}  ${title}${meta}`));

            // members strip
            if (connected) {
              const strip = members
                .map((m) => {
                  const color = m.state === "banned"
                    ? "error"
                    : m.state === "muted"
                      ? "warning"
                      : m.connected
                        ? "success"
                        : "dim";
                  const glyph = m.role === "master" ? "\u2605" : "\u2022";
                  const suffix = m.agentId === agentId ? theme.fg("dim", " (you)") : "";
                  return theme.fg(color, `${glyph} ${m.agentId}`) + suffix;
                })
                .join(theme.fg("dim", "   "));
              container.addChild(line(strip));
            }
            container.addChild(new Spacer(1));

            // log (scrollable)
            const total = askLog.length;
            const clampedScroll = Math.max(0, Math.min(scroll, Math.max(0, total - 1)));
            const end = total - clampedScroll;
            const start = Math.max(0, end - 20);
            const visible = askLog.slice(start, end);

            if (visible.length === 0) {
              container.addChild(line(theme.fg("dim", "(no activity yet - /chat_ask, /chat_say or /chat_turn to start)")));
            }
            for (let i = 0; i < visible.length; i++) {
              const entry = visible[i];
              const time = theme.fg("dim", fmtTime(entry.ts));
              const arrow = entry.direction === "out"
                ? theme.fg("accent", "\u2192")
                : theme.fg("success", "\u2190");
              const peer = theme.fg("toolTitle", entry.peer);
              const status = theme.fg(stateColor(entry.status), `[${entry.status}]`);
              const promptLine = entry.prompt
                .replace(/^\[(?:broadcast|turn)\]\s*/, "")
                .replace(/\n/g, " ")
                .slice(0, 240);
              container.addChild(line(`${time} ${kindBadge(entry.prompt)} ${arrow} ${peer} ${status}`));
              container.addChild(line(`     ${theme.fg("muted", promptLine)}`));
              for (const [from, resp] of entry.responses) {
                container.addChild(
                  line(`     ${theme.fg("success", `\u2190 ${from}`)} ${theme.fg(stateColor(resp.status), `[${resp.status}]`)}`),
                );
                const bodyLines = resp.text.split("\n").slice(0, 8);
                for (const l of bodyLines) {
                  container.addChild(
                    line(`       ${theme.fg("borderMuted", "\u2502 ")}${theme.fg("fg", l)}`),
                  );
                }
                if (resp.text.split("\n").length > 8) {
                  container.addChild(
                    line(`       ${theme.fg("dim", "...")}`),
                  );
                }
              }
              if (i < visible.length - 1) container.addChild(new Spacer(1));
            }

            container.addChild(new Spacer(1));

            // footer with hints + scroll indicator
            const scrollIndicator = total > visible.length
              ? theme.fg("muted", `  [${end}/${total}]`)
              : theme.fg("dim", `  [${total}]`);
            const hints = [
              theme.fg("accent", "esc") + theme.fg("dim", " close"),
              theme.fg("accent", "j/k") + theme.fg("dim", " scroll"),
              theme.fg("accent", "i") + theme.fg("dim", " insert"),
              theme.fg("accent", "a") + theme.fg("dim", "/") + theme.fg("accent", "s") + theme.fg("dim", "/") + theme.fg("accent", "t") + theme.fg("dim", " ask/say/turn"),
            ].join(theme.fg("dim", "  \u00B7  "));
            container.addChild(line(hints + scrollIndicator));

            // bottom rule (muted so top pops)
            container.addChild(
              new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
            );
          };

          rebuild();
          chatWindowInvalidate = () => {
            rebuild();
            container.invalidate();
          };

          return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              if (matchesKey(data, "escape") || data === "x" || data === "q") {
                chatWindowInvalidate = undefined;
                done();
                return;
              }
              if (data === "j" || matchesKey(data, "down")) {
                scroll = Math.max(0, scroll - 1);
                rebuild();
                container.invalidate();
                return;
              }
              if (data === "k" || matchesKey(data, "up")) {
                scroll = Math.min(askLog.length, scroll + 1);
                rebuild();
                container.invalidate();
                return;
              }
              if (data === "i") {
                const last = [...askLog].reverse().find((e) => e.responses.size > 0);
                if (last) {
                  const texts = [...last.responses.entries()]
                    .map(([from, r]) => `Response from ${from}:\n${r.text}`)
                    .join("\n\n");
                  ctx.ui.setEditorText(texts);
                  chatWindowInvalidate = undefined;
                  done();
                }
                return;
              }
              if (data === "s") {
                ctx.ui.setEditorText("/chat_say ");
                chatWindowInvalidate = undefined;
                done();
                return;
              }
              if (data === "t") {
                ctx.ui.setEditorText("/chat_turn ");
                chatWindowInvalidate = undefined;
                done();
                return;
              }
              if (data === "a") {
                ctx.ui.setEditorText("/chat_ask ");
                chatWindowInvalidate = undefined;
                done();
              }
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-right",
            width: "55%",
            minWidth: 60,
            maxHeight: "75%",
            margin: 1,
            visible: (w) => w >= 80,
          },
        },
      );
    },
  });

  pi.registerCommand("chat_pane", {
    description: "Show the chat pane (ask/response history)",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      if (ctx.mode !== "tui") {
        notify("chat pane needs interactive mode", "warning");
        return;
      }
      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        const container = new Container();
        const render = () => {
          container.clear();
          container.addChild(
            new Text(theme.fg("accent", theme.bold("shitty.chat pane")), 1, 0),
          );
          if (askLog.length === 0) {
            container.addChild(new Text(theme.fg("dim", "no asks yet"), 1, 0));
          }
          for (const entry of askLog.slice(-20)) {
            const arrow = entry.direction === "out" ? "->" : "<-";
            container.addChild(
              new Text(
                theme.fg("accent", `${arrow} ${entry.peer} `) +
                  theme.fg("muted", `[${entry.status}] `) +
                  theme.fg("dim", `(${entry.askId.slice(0, 8)})`),
                1,
                0,
              ),
            );
            container.addChild(new Text(theme.fg("muted", `   ${entry.prompt.slice(0, 200)}`), 1, 0));
            for (const [from, resp] of entry.responses) {
              container.addChild(
                new Text(
                  theme.fg("success", `   ${from} [${resp.status}]:`) + "\n" +
                    resp.text
                      .split("\n")
                      .map((l) => `     ${l}`)
                      .join("\n"),
                  1,
                  0,
                ),
              );
            }
          }
          container.addChild(
            new Text(theme.fg("dim", "esc close | i insert last response into editor"), 1, 0),
          );
        };
        render();
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (matchesKey(data, "escape")) done();
            if (data === "i") {
              const last = [...askLog].reverse().find((e) => e.responses.size > 0);
              if (last) {
                const texts = [...last.responses.entries()]
                  .map(([from, r]) => `Response from ${from}:\n${r.text}`)
                  .join("\n\n");
                ctx.ui.setEditorText(texts);
              }
              done();
            }
          },
        };
      });
    },
  });

  pi.registerCommand("chat_pull", {
    description: "Inject an ask's responses into the session: /chat_pull <askId-prefix>",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const prefix = (args ?? "").trim();
      const entry = prefix
        ? askLog.find((e) => e.askId.startsWith(prefix))
        : [...askLog].reverse().find((e) => e.responses.size > 0);
      if (!entry || entry.responses.size === 0) {
        notify("chat: no matching ask with responses", "warning");
        return;
      }
      const body = [
        `[shitty-chat] Responses to ask "${entry.prompt.slice(0, 120)}":`,
        ...[...entry.responses.entries()].map(([from, r]) => `--- ${from} ---\n${r.text}`),
      ].join("\n\n");
      pi.sendMessage(
        { customType: "shitty-chat", content: body, display: true },
        { deliverAs: "nextTurn" },
      );
      notify("chat: responses queued for next turn context");
    },
  });

  pi.registerCommand("chat_config", {
    description: "Configure shitty-chat (askPolicy, answerMode, allowlist, autoConnect)",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      if (!ctx.hasUI) return;
      const field = await ctx.ui.select("chat config:", [
        `displayName (${config.displayName ?? defaultDisplayName + " (default)"})`,
        `askPolicy (${config.askPolicy})`,
        `answerMode (${config.answerMode})`,
        `allowlist (${config.allowlist.join(",") || "empty"})`,
        `autoConnect (${config.autoConnect})`,
        `relayUrl (${config.relayUrl})`,
      ]);
      if (!field) return;
      if (field.startsWith("displayName")) {
        const v = await ctx.ui.input(
          "display name (blank to reset to default):",
          config.displayName ?? "",
        );
        if (v !== undefined) {
          config.displayName = v.trim() ? v.trim().slice(0, 64) : undefined;
        }
      } else if (field.startsWith("askPolicy")) {
        const v = await ctx.ui.select("askPolicy:", ["confirm", "auto", "allowlist"]);
        if (v) config.askPolicy = v as Config["askPolicy"];
      } else if (field.startsWith("answerMode")) {
        const v = await ctx.ui.select("answerMode:", ["readonly", "agent"]);
        if (v === "agent") {
          const ok = await ctx.ui.confirm(
            "Enable agent mode?",
            "Accepted asks will run REAL tool-using turns on this machine (remote code execution). Continue?",
          );
          if (!ok) return;
        }
        if (v) config.answerMode = v as Config["answerMode"];
      } else if (field.startsWith("allowlist")) {
        const v = await ctx.ui.input("allowlist (comma-separated agent ids):", config.allowlist.join(","));
        if (v !== undefined) config.allowlist = v.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (field.startsWith("autoConnect")) {
        config.autoConnect = !config.autoConnect;
      } else if (field.startsWith("relayUrl")) {
        const v = await ctx.ui.input("relay url:", config.relayUrl);
        if (v) config.relayUrl = v;
      }
      saveConfig(config);
      notify(`chat config saved: policy=${config.askPolicy} mode=${config.answerMode}`);
    },
  });

  // ---- tools (LLM-callable equivalents of the ask/members commands) ----

  const requireConnectionForTool = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("shitty-chat: not connected. run /chat_join <roomKey> first");
    }
  };

  async function toolAsk(
    prompt: string,
    target: string,
    withContext: boolean,
    ctx: ExtensionContext,
  ): Promise<string> {
    requireConnectionForTool();
    lastCtx = ctx;
    if (!e2eKey) throw new Error("shitty-chat: no encryption key");
    let resolvedTarget = target;
    if (target === "master") {
      resolvedTarget = members.find((m) => m.role === "master")?.agentId ?? "master";
    } else if (target && target !== "all") {
      const match = members.find((m) => m.agentId === target);
      if (!match) {
        const online = members.filter((m) => m.agentId !== agentId).map((m) => m.agentId);
        throw new Error(
          `shitty-chat: no agent "${target}" in this room. connected agents: ${online.join(", ") || "(none)"}`,
        );
      }
    }

    const askId = globalThis.crypto.randomUUID();
    const promptBlob = await seal(e2eKey, prompt, AAD.ask(askId));
    let contextBlob;
    if (withContext) {
      const bundle = await buildContextBundle(ctx);
      contextBlob = await seal(e2eKey, bundle, AAD.ctx(askId));
    }
    const entry: AskEntry = {
      askId,
      direction: "out",
      peer: resolvedTarget || "all",
      prompt,
      status: "sent",
      responses: new Map(),
      ts: Date.now(),
    };
    askLog.push(entry);
    sendEnvelope("ask", {
      askId,
      prompt: promptBlob,
      context: contextBlob,
      target: resolvedTarget || "all",
      agentMode: true,
    });
    updateWidget();

    // Wait for responses (or 300s timeout). Broadcast asks resolve once all
    // reachable agents have replied or 30s pass since the first reply.
    return new Promise<string>((resolve) => {
      const expectedResponders = (resolvedTarget && resolvedTarget !== "all")
        ? 1
        : members.filter((m) => m.agentId !== agentId && m.connected && m.state === "active").length;
      let firstReplyAt = 0;
      const finish = () => {
        clearInterval(poll);
        clearTimeout(hard);
        if (entry.responses.size === 0) {
          resolve(`shitty-chat: no responses within timeout for ask ${askId.slice(0, 8)}`);
          return;
        }
        const parts: string[] = [];
        for (const [from, r] of entry.responses) {
          parts.push(`--- response from ${from} (${r.status}) ---\n${r.text}`);
        }
        resolve(parts.join("\n\n"));
      };
      const poll = setInterval(() => {
        const finals = [...entry.responses.values()].filter((r) => r.status === "final").length;
        if (finals >= expectedResponders && expectedResponders > 0) {
          finish();
          return;
        }
        if (finals > 0 && !firstReplyAt) firstReplyAt = Date.now();
        if (firstReplyAt && Date.now() - firstReplyAt > 30_000) finish();
      }, 500);
      const hard = setTimeout(finish, 300_000);
    });
  }

  pi.registerTool({
    name: "shitty_chat_ask",
    label: "chat: ask",
    description:
      "Ask other pi agents in the current shitty.chat room a question. They answer with a real LLM call using THEIR own session context (their code, git state, terminal history), all end-to-end encrypted. Use this when the user wants to delegate a question or check something on another machine.",
    promptSnippet:
      "Ask another pi agent in the shared room; they answer using their own session context.",
    promptGuidelines: [
      "Use shitty_chat_ask when the user wants another agent to answer using ITS own context (not yours), e.g. 'ask windows what version it has', 'check with the linux agent'.",
      "Use shitty_chat_ask_with_context when your local context is what matters, e.g. 'have windows run the build I just changed'.",
      "target 'all' broadcasts; use a specific agentId or 'master' for a single recipient. Call shitty_chat_members first if you do not know who is in the room.",
    ],
    parameters: Type.Object({
      target: Type.String({
        description: "agentId (e.g. 'linux-a1f3'), 'master', or 'all' to broadcast",
      }),
      prompt: Type.String({ description: "the question or instruction for the remote agent(s)" }),
      withContext: Type.Optional(
        Type.Boolean({
          description:
            "if true, ship YOUR session context (recent messages, cwd, git state) so the remote agent can act on it",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = await toolAsk(params.prompt, params.target, !!params.withContext, ctx);
      return { content: [{ type: "text" as const, text }], details: { askId: askLog.at(-1)?.askId } };
    },
  });

  pi.registerTool({
    name: "shitty_chat_ask_with_context",
    label: "chat: ask with my context",
    description:
      "Ask another pi agent to do something, and ship YOUR current session context along (recent messages, cwd, git branch + status). Use this for 'run the build I just changed on windows'-style delegation.",
    parameters: Type.Object({
      target: Type.String({ description: "agentId, 'master', or 'all'" }),
      prompt: Type.String({ description: "the task/question" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = await toolAsk(params.prompt, params.target, true, ctx);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  pi.registerTool({
    name: "shitty_chat_members",
    label: "chat: list room members",
    description:
      "List the pi agents currently in your shitty.chat room (agentId, name, platform, role, online state). Call this before shitty_chat_ask if you don't know who is in the room.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      requireConnectionForTool();
      lastCtx = ctx;
      const lines = members.map(
        (m) =>
          `${m.agentId}\t${m.name}\t${m.platform}\t${m.role}\t${m.state}\t${m.connected ? "online" : "offline"}${m.agentId === agentId ? "\t(me)" : ""}`,
      );
      const text = lines.length
        ? `agentId\tname\tplatform\trole\tstate\tonline\n${lines.join("\n")}`
        : "no members";
      return { content: [{ type: "text" as const, text }], details: { members } };
    },
  });

  pi.registerTool({
    name: "shitty_chat_status",
    label: "chat: status",
    description: "Report shitty.chat connection status: your agentId, role, room, relay URL.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return { content: [{ type: "text" as const, text: "shitty-chat: not connected" }], details: {} };
      }
      const online = members.filter((m) => m.connected).map((m) => m.agentId).join(", ");
      return {
        content: [
          {
            type: "text" as const,
            text: `agentId=${agentId} role=${role} room="${roomName}" relay=${config.relayUrl} online=[${online}] policy=${config.askPolicy} mode=${config.answerMode}`,
          },
        ],
        details: { agentId, role, roomName, members },
      };
    },
  });

  pi.registerTool({
    name: "shitty_chat_turn",
    label: "chat: provoke remote turn",
    description:
      "Inject a REAL user turn on other pi agents (LLM + tools run on their side, visible in their session). Waits for the remote to finish and returns their summary. Use for delegating actual work like 'go run the build on windows'. Target a single agentId, 'master', or 'all' to broadcast.",
    promptGuidelines: [
      "Use shitty_chat_turn when you want the remote agent to ACTUALLY execute something (run a command, edit a file, install a dep). It becomes a full user turn on their session with tools and its summary comes back.",
      "Prefer shitty_chat_ask when you only need an answer without any action on the remote machine.",
    ],
    parameters: Type.Object({
      target: Type.String({ description: "agentId, 'master', or 'all'" }),
      prompt: Type.String({ description: "the instruction/prompt to run as a user turn on the remote(s)" }),
      wait: Type.Optional(
        Type.Boolean({
          description: "wait for remote(s) to finish and return their summary (default true)",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireConnectionForTool();
      lastCtx = ctx;
      if (!e2eKey) throw new Error("shitty-chat: no encryption key");
      let target = params.target;
      if (target === "master") {
        target = members.find((m) => m.role === "master")?.agentId ?? target;
      } else if (target && target !== "all") {
        if (!members.find((m) => m.agentId === target)) {
          const online = members.filter((m) => m.agentId !== agentId).map((m) => m.agentId);
          throw new Error(
            `shitty-chat: no agent "${target}" in this room. connected agents: ${online.join(", ") || "(none)"}`,
          );
        }
      }
      const turnId = globalThis.crypto.randomUUID();
      const blob = await seal(e2eKey, params.prompt, AAD.turn(turnId, agentId));
      sendEnvelope("turn", { turnId, prompt: blob, target: target || "all" });

      const entry: AskEntry = {
        askId: turnId,
        direction: "out",
        peer: target || "all",
        prompt: `[turn] ${params.prompt}`,
        status: "sent",
        responses: new Map(),
        ts: Date.now(),
      };
      askLog.push(entry);
      updateWidget();

      const recipients = target === "all"
        ? members.filter((m) => m.connected && m.agentId !== agentId && m.state === "active").map((m) => m.agentId)
        : [target || "all"];

      if (params.wait === false) {
        return {
          content: [
            { type: "text" as const, text: `turn provoked on ${recipients.length} agent(s): ${recipients.join(", ")} (fire-and-forget)` },
          ],
          details: { turnId, recipients },
        };
      }

      const summary = await new Promise<string>((resolve) => {
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
          const finals = [...entry.responses.values()].filter((r) => r.status === "final" || r.status === "error").length;
          if (finals >= expected) return finish();
          if (finals > 0 && !firstAt) firstAt = Date.now();
          if (firstAt && Date.now() - firstAt > 30_000) finish();
        }, 500);
        const hard = setTimeout(finish, 600_000);
      });
      return {
        content: [{ type: "text" as const, text: summary }],
        details: { turnId, recipients },
      };
    },
  });

  pi.registerTool({
    name: "shitty_chat_say",
    label: "chat: broadcast message",
    description:
      "Broadcast a plain-text message to every agent in the room. Unlike shitty_chat_ask, this does NOT trigger an LLM call on the receiving side - it just delivers the text as a chat notification. Use for announcements or coordination signals like 'starting the build now'.",
    parameters: Type.Object({
      text: Type.String({ description: "message body to broadcast to the room" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireConnectionForTool();
      lastCtx = ctx;
      if (!e2eKey) throw new Error("shitty-chat: no encryption key");
      const sayId = globalThis.crypto.randomUUID();
      const blob = await seal(e2eKey, params.text, AAD.say(sayId, agentId));
      sendEnvelope("say", { sayId, text: blob });
      const recipients = members.filter((m) => m.connected && m.agentId !== agentId).map((m) => m.agentId);
      return {
        content: [{ type: "text" as const, text: `broadcast delivered to ${recipients.length} agent(s): ${recipients.join(", ") || "(none)"}` }],
        details: { sayId, recipients },
      };
    },
  });

  pi.registerTool({
    name: "shitty_chat_moderate",
    label: "chat: moderate",
    description:
      "Master-only: moderate a member of the current shitty.chat room. Use when the user asks to kick/ban/mute/unmute/unban another agent.",
    parameters: Type.Object({
      action: StringEnum(["kick", "ban", "unban", "mute", "unmute"] as const),
      agentId: Type.String({ description: "target agentId (see shitty_chat_members)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireConnectionForTool();
      lastCtx = ctx;
      if (role !== "master") {
        throw new Error("shitty_chat_moderate: only the master can moderate");
      }
      const map = {
        kick: "room_kick",
        ban: "room_ban",
        unban: "room_unban",
        mute: "room_mute",
        unmute: "room_unmute",
      } as const;
      sendEnvelope(map[params.action], { targetAgentId: params.agentId });
      return {
        content: [{ type: "text" as const, text: `${params.action} ${params.agentId}: sent` }],
        details: {},
      };
    },
  });

  // ---- message renderer for /chat_pull injections ----

  pi.registerMessageRenderer("shitty-chat", (message, _options, theme) => {
    return new Text(theme.fg("accent", "[shitty-chat] ") + String(message.content), 0, 0);
  });

  // ---- lifecycle ----

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    config = loadConfig();
    if (config.autoConnect && config.roomKey && (!ws || ws.readyState !== WebSocket.OPEN)) {
      connect(config.roomKey, config.relayUrl)
        .then(() => notify(`chat: rejoined "${roomName}" as ${agentId}`))
        .catch((err) => notify(`chat: auto-connect failed: ${err.message}`, "warning"));
    }
    updateStatus();
  });

  pi.on("agent_start", async (_event, ctx) => {
    lastCtx = ctx;
  });

  pi.on("session_shutdown", async () => {
    disconnect();
  });
}
