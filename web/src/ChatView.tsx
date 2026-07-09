// Browser chat client. Derives e2e/auth keys from the pasted room key
// (identical HKDF as the pi extension), connects to /ws, sends and
// receives encrypted asks / says / turns. Since the browser has no LLM,
// it auto-declines incoming asks and turns with a friendly message.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { wsUrl } from "./api";

// ---------------------------------------------------------------------------
// Parse structured @@sc-evt:{JSON}@@ markers embedded in streaming responses
// so we can render tool calls as pi-style rows instead of raw markdown.

type ScEvent =
  | { kind: "start"; agentId?: string; action?: "ask" | "turn" }
  | { kind: "tool_start"; toolCallId?: string; name: string; arg?: string }
  | {
      kind: "tool_end";
      toolCallId?: string;
      name: string;
      error?: boolean;
      summary?: string;
      output?: string;
    };

type Segment =
  | { kind: "text"; text: string }
  | { kind: "event"; event: ScEvent };

function parseSegments(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /@@sc-evt:([^\n]+?)@@/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    try {
      out.push({ kind: "event", event: JSON.parse(m[1]) as ScEvent });
    } catch {
      // ignore malformed markers
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

// Merge tool_start + subsequent tool_end so each tool call renders as ONE
// row. Prefer toolCallId matching; fall back to "last unfinished row with
// same name" for cases where the wire event drops the id (Anthropic emits
// ids, but tests / older providers might not).
type ToolRow = {
  key: string;
  name: string;
  arg?: string;
  status: "running" | "done" | "error";
  summary?: string;
  output?: string;
};
function mergeToolEvents(events: ScEvent[]): ToolRow[] {
  const rows: ToolRow[] = [];
  const byId = new Map<string, number>();
  for (const ev of events) {
    if (ev.kind === "tool_start") {
      const key = ev.toolCallId ?? `${ev.name}#${rows.length}`;
      byId.set(key, rows.length);
      rows.push({ key, name: ev.name, arg: ev.arg, status: "running" });
    } else if (ev.kind === "tool_end") {
      let idx: number | undefined;
      if (ev.toolCallId) idx = byId.get(ev.toolCallId);
      if (idx === undefined) {
        // Fallback: newest still-running row with matching name.
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].name === ev.name && rows[i].status === "running") {
            idx = i;
            break;
          }
        }
      }
      if (idx !== undefined) {
        rows[idx].status = ev.error ? "error" : "done";
        rows[idx].summary = ev.summary;
        rows[idx].output = ev.output;
        if (ev.toolCallId) byId.delete(ev.toolCallId);
      } else {
        // Truly orphaned end: render standalone (rare).
        rows.push({
          key: `orphan#${rows.length}`,
          name: ev.name,
          status: ev.error ? "error" : "done",
          summary: ev.summary,
          output: ev.output,
        });
      }
    }
  }
  return rows;
}

function toolIconFor(name: string) {
  // A tiny mnemonic per common tool. Keep muted colors, this is chat not a
  // rainbow show.
  if (name === "bash" || name === "shell") return "$";
  if (name === "read" || name === "cat" || name === "grep" || name === "find") return "\u2637";
  if (name === "write" || name === "edit" || name === "apply_patch") return "\u270E";
  if (name === "ls") return "\u2261";
  if (name.startsWith("shitty_chat")) return "\u25C6";
  return "\u2699";
}

function ToolRowView({ row }: { row: ToolRow }) {
  const glyph = toolIconFor(row.name);
  const [open, setOpen] = useState(false);
  const outputLines = row.output ? row.output.split("\n") : [];
  const canExpand = row.output && row.output.trim().length > 0;
  const summaryLine =
    row.status === "done" && outputLines.length > 0
      ? outputLines.length === 1
        ? outputLines[0].slice(0, 120)
        : `${outputLines.length} lines`
      : row.summary;
  return (
    <div className={`tool-row ${row.status}`}>
      <div
        className={`tool-row-head ${canExpand ? "clickable" : ""}`}
        onClick={() => canExpand && setOpen((v) => !v)}
        role={canExpand ? "button" : undefined}
        tabIndex={canExpand ? 0 : undefined}
        onKeyDown={(e) => {
          if (canExpand && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span className="tool-icon" aria-hidden="true">
          {row.status === "running"
            ? "\u25CB"
            : row.status === "error"
              ? "\u2716"
              : "\u2713"}
        </span>
        <span className="tool-glyph">{glyph}</span>
        <span className="tool-name-badge">{row.name}</span>
        {row.arg && <code className="tool-arg-code">{row.arg}</code>}
        {summaryLine && (
          <span className={`tool-summary-text ${row.status === "error" ? "err" : "ok"}`}>
            {summaryLine}
          </span>
        )}
        {canExpand && (
          <span className="tool-caret" aria-hidden="true">
            {open ? "\u25BE" : "\u25B8"}
          </span>
        )}
      </div>
      {open && row.output && (
        <pre className="tool-output" onClick={(e) => e.stopPropagation()}>
          {row.output}
        </pre>
      )}
    </div>
  );
}

function ResponseBody({ text }: { text: string }) {
  const segments = useMemo(() => parseSegments(text), [text]);
  const rendered: React.ReactNode[] = [];
  let eventBuffer: ScEvent[] = [];

  const flushEvents = () => {
    if (eventBuffer.length === 0) return;
    const rows = mergeToolEvents(eventBuffer);
    if (rows.length > 0) {
      rendered.push(
        <div className="tool-block" key={`tools-${rendered.length}`}>
          {rows.map((r) => (
            <ToolRowView key={r.toolCallId} row={r} />
          ))}
        </div>,
      );
    }
    eventBuffer = [];
  };

  for (const seg of segments) {
    if (seg.kind === "event") {
      eventBuffer.push(seg.event);
    } else {
      const clean = seg.text.replace(/^\s+|\s+$/g, "");
      // Whitespace between adjacent tool events is noise - we only flush
      // the tool buffer when real prose shows up, so a tool_start followed
      // by a tool_end merges into one row instead of splitting into two
      // separate tool-blocks.
      if (!clean) continue;
      flushEvents();
      rendered.push(
        <div className="markdown" key={`md-${rendered.length}`}>
          <Streamdown
            parseIncompleteMarkdown
            controls={false}
            lineNumbers={false}
          >
            {seg.text}
          </Streamdown>
        </div>,
      );
    }
  }
  flushEvents();

  return <>{rendered}</>;
}
import {
  deriveKeys,
  openBlob,
  seal,
  type DerivedKeys,
} from "../../shared/crypto";
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
} from "../../shared/protocol";

// relayUrl is imported from ./api to keep dashboard / relay URL config in
// one place (supports single-container deploy or split Vercel + backend).

function getIdentity(): string {
  let id = localStorage.getItem("sc-identity");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("sc-identity", id);
  }
  return id;
}

function getStoredDisplayName(): string {
  return localStorage.getItem("sc-display-name") ?? "";
}

function setStoredDisplayName(name: string) {
  if (name.trim()) localStorage.setItem("sc-display-name", name.trim().slice(0, 64));
  else localStorage.removeItem("sc-display-name");
}

interface LogEntry {
  id: string;
  ts: number;
  kind: "ask" | "say" | "turn" | "system";
  direction: "in" | "out" | "info";
  peer: string;
  status: string;
  text: string;
  responses: Map<string, { text: string; status: string }>;
}

export function ChatView({
  email,
  onExit,
  initialKey,
}: {
  email: string;
  onExit: () => void;
  initialKey?: string;
}) {
  const [roomKeyInput, setRoomKeyInput] = useState(initialKey ?? "");
  const [displayNameInput, setDisplayNameInput] = useState(getStoredDisplayName());
  const [state, setState] = useState<
    | { phase: "input" }
    | { phase: "connecting" }
    | { phase: "connected"; agentId: string; role: string; roomName: string }
    | { phase: "error"; message: string }
  >({ phase: "input" });
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [outText, setOutText] = useState("");
  const [outKind, setOutKind] = useState<"ask" | "say" | "turn">("ask");
  const [outTarget, setOutTarget] = useState<string>("all");
  const [withContext, setWithContext] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const keysRef = useRef<DerivedKeys | null>(null);
  const stateRef = useRef(state); // for handlers
  stateRef.current = state;

  // 2s hysteresis so brief reconnects (identity re-hello) don't flicker
  // "offline" next to a member's name.
  const [stableOffline, setStableOffline] = useState<Set<string>>(new Set());
  useEffect(() => {
    const currentlyOffline = new Set(
      members.filter((m) => !m.connected && m.state !== "banned").map((m) => m.agentId),
    );
    // Anyone now online should be removed from the stableOffline set right away.
    setStableOffline((prev) => {
      const next = new Set([...prev].filter((id) => currentlyOffline.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // For newly-offline members, wait 2s before marking stably offline.
    const timers = [...currentlyOffline]
      .filter((id) => !stableOffline.has(id))
      .map((id) =>
        setTimeout(() => {
          setStableOffline((prev) => {
            const stillOffline = members.find((m) => m.agentId === id)?.connected === false;
            if (!stillOffline || prev.has(id)) return prev;
            const next = new Set(prev);
            next.add(id);
            return next;
          });
        }, 2000),
      );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members]);

  const appendLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [...prev.slice(-99), entry]);
  }, []);

  const updateLog = useCallback((id: string, fn: (e: LogEntry) => LogEntry) => {
    setLog((prev) => prev.map((e) => (e.id === id ? fn(e) : e)));
  }, []);

  const sendEnvelope = useCallback((type: string, payload?: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
  }, []);

  const handleServer = useCallback(
    async (msg: Envelope) => {
      const e2e = keysRef.current?.e2eKey;
      switch (msg.type) {
        case "member_update": {
          const p = msg.payload as { members: MemberInfo[] };
          setMembers(p.members);
          return;
        }
        case "ask_received": {
          if (!e2e) return;
          const p = msg.payload as AskPayload;
          let promptText = "(decrypt failed)";
          try {
            promptText = await openBlob(e2e, p.prompt, AAD.ask(p.askId));
          } catch {}
          appendLog({
            id: p.askId,
            ts: Date.now(),
            kind: "ask",
            direction: "in",
            peer: msg.from ?? "?",
            status: "declined (browser)",
            text: promptText,
            responses: new Map(),
          });
          sendEnvelope("ask_ack", { askId: p.askId, status: "declined" });
          return;
        }
        case "turn_received": {
          if (!e2e) return;
          const p = msg.payload as TurnPayload;
          let promptText = "(decrypt failed)";
          try {
            promptText = await openBlob(e2e, p.prompt, AAD.turn(p.turnId, msg.from ?? "?"));
          } catch {}
          appendLog({
            id: p.turnId,
            ts: Date.now(),
            kind: "turn",
            direction: "in",
            peer: msg.from ?? "?",
            status: "ignored (browser has no LLM)",
            text: promptText,
            responses: new Map(),
          });
          return;
        }
        case "say_received": {
          if (!e2e) return;
          const p = msg.payload as SayPayload;
          let text = "(decrypt failed)";
          try {
            text = await openBlob(e2e, p.text, AAD.say(p.sayId, msg.from ?? "?"));
          } catch {}
          appendLog({
            id: p.sayId,
            ts: Date.now(),
            kind: "say",
            direction: "in",
            peer: msg.from ?? "?",
            status: "received",
            text,
            responses: new Map(),
          });
          return;
        }
        case "ask_ack": {
          const p = msg.payload as AskAckPayload;
          updateLog(p.askId, (entry) => {
            const responses = new Map(entry.responses);
            const from = msg.from ?? "?";
            responses.set(from, { text: responses.get(from)?.text ?? "", status: p.status });
            return { ...entry, responses };
          });
          return;
        }
        case "ask_response": {
          if (!e2e) return;
          const p = msg.payload as AskResponsePayload;
          const from = msg.from ?? "?";
          let chunkText = "";
          if (p.chunk) {
            try {
              chunkText = await openBlob(e2e, p.chunk, AAD.resp(p.askId, from));
            } catch {
              chunkText = "[decrypt failed]";
            }
          }
          updateLog(p.askId, (entry) => {
            const responses = new Map(entry.responses);
            const prev = responses.get(from)?.text ?? "";
            responses.set(from, { text: prev + chunkText, status: p.status });
            const status = p.status === "final" ? "answered" : entry.status;
            return { ...entry, responses, status };
          });
          return;
        }
        case "turn_response": {
          if (!e2e) return;
          const p = msg.payload as TurnResponsePayload;
          const from = msg.from ?? "?";
          let chunkText = "";
          if (p.chunk) {
            try {
              chunkText = await openBlob(e2e, p.chunk, AAD.turnResp(p.turnId, from));
            } catch {
              chunkText = "[decrypt failed]";
            }
          }
          if (p.error) chunkText += `[error: ${p.error}]`;
          updateLog(p.turnId, (entry) => {
            const responses = new Map(entry.responses);
            const prev = responses.get(from)?.text ?? "";
            responses.set(from, { text: prev + chunkText, status: p.status });
            const status = p.status === "final" ? "answered" : p.status === "error" ? "error" : entry.status;
            return { ...entry, responses, status };
          });
          return;
        }
        case "bye": {
          const p = msg.payload as { reason: string };
          appendLog({
            id: crypto.randomUUID(),
            ts: Date.now(),
            kind: "system",
            direction: "info",
            peer: "relay",
            status: p.reason,
            text: `disconnected by relay (${p.reason})`,
            responses: new Map(),
          });
          setState({ phase: "error", message: `disconnected: ${p.reason}` });
          wsRef.current?.close();
          return;
        }
        case "error": {
          const p = msg.payload as { code: string; message: string };
          appendLog({
            id: crypto.randomUUID(),
            ts: Date.now(),
            kind: "system",
            direction: "info",
            peer: "relay",
            status: p.code,
            text: p.message,
            responses: new Map(),
          });
          return;
        }
      }
    },
    [appendLog, updateLog, sendEnvelope],
  );

  const connect = useCallback(
    async (roomKey: string) => {
      setState({ phase: "connecting" });
      let derived: DerivedKeys;
      try {
        derived = await deriveKeys(roomKey);
      } catch (e) {
        setState({ phase: "error", message: `invalid key: ${e}` });
        return;
      }
      keysRef.current = derived;

      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        const name = getStoredDisplayName() || `${email}@browser`;
        ws.send(
          JSON.stringify({
            type: "hello",
            payload: {
              authKey: derived.authKeyHex,
              identity: getIdentity(),
              name,
              platform: "browser",
            },
          }),
        );
      };
      ws.onmessage = async (event) => {
        let msg: Envelope;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === "welcome") {
          const w = msg.payload as WelcomePayload;
          setState({ phase: "connected", agentId: w.agentId, role: w.role, roomName: w.roomName });
          setMembers(w.members);
          appendLog({
            id: crypto.randomUUID(),
            ts: Date.now(),
            kind: "system",
            direction: "info",
            peer: "relay",
            status: "joined",
            text: `joined "${w.roomName}" as ${w.agentId} [${w.role}]`,
            responses: new Map(),
          });
          return;
        }
        if (msg.type === "error" && stateRef.current.phase !== "connected") {
          const p = msg.payload as { code: string; message: string };
          setState({ phase: "error", message: `${p.code}: ${p.message}` });
          ws.close();
          return;
        }
        handleServer(msg).catch(() => {});
      };
      ws.onerror = () => {
        setState({ phase: "error", message: "websocket error" });
      };
      ws.onclose = () => {
        if (stateRef.current.phase === "connected") {
          setState({ phase: "error", message: "connection closed" });
        }
      };
    },
    [email, handleServer, appendLog],
  );

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  // If we were opened with a prefilled key (e.g. right after room creation),
  // auto-connect on mount so the user lands in chat with one click.
  const autoConnectRef = useRef(false);
  useEffect(() => {
    if (!autoConnectRef.current && initialKey && initialKey.trim() && state.phase === "input") {
      autoConnectRef.current = true;
      connect(initialKey.trim());
    }
  }, [initialKey, state.phase, connect]);

  const send = useCallback(async () => {
    const text = outText.trim();
    if (!text || !keysRef.current || stateRef.current.phase !== "connected") return;
    const e2e = keysRef.current.e2eKey;
    const myId = stateRef.current.agentId;
    if (outKind === "ask") {
      const askId = crypto.randomUUID();
      const promptBlob = await seal(e2e, text, AAD.ask(askId));
      let contextBlob;
      if (withContext) {
        contextBlob = await seal(
          e2e,
          `[browser context]\nurl: ${location.href}\nemail: ${email}\n(browser has no working directory / git state)`,
          AAD.ctx(askId),
        );
      }
      sendEnvelope("ask", { askId, prompt: promptBlob, context: contextBlob, target: outTarget, agentMode: true });
      appendLog({
        id: askId,
        ts: Date.now(),
        kind: "ask",
        direction: "out",
        peer: outTarget,
        status: "sent",
        text,
        responses: new Map(),
      });
    } else if (outKind === "say") {
      const sayId = crypto.randomUUID();
      const blob = await seal(e2e, text, AAD.say(sayId, myId));
      sendEnvelope("say", { sayId, text: blob });
      appendLog({
        id: sayId,
        ts: Date.now(),
        kind: "say",
        direction: "out",
        peer: "all",
        status: "sent",
        text,
        responses: new Map(),
      });
    } else if (outKind === "turn") {
      const turnId = crypto.randomUUID();
      const blob = await seal(e2e, text, AAD.turn(turnId, myId));
      sendEnvelope("turn", { turnId, prompt: blob, target: outTarget });
      appendLog({
        id: turnId,
        ts: Date.now(),
        kind: "turn",
        direction: "out",
        peer: outTarget,
        status: "sent",
        text,
        responses: new Map(),
      });
    }
    setOutText("");
  }, [outText, outKind, outTarget, withContext, sendEnvelope, appendLog, email]);

  const targetOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [{ value: "all", label: "everyone" }];
    if (state.phase === "connected") {
      for (const m of members) {
        if (m.agentId === state.agentId) continue;
        opts.push({ value: m.agentId, label: `${m.agentId} (${m.name})` });
      }
    }
    return opts;
  }, [members, state]);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // Auto-grow the composer textarea up to ~8 lines, then let it scroll.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    const line = 20; // ~ line-height in px
    const min = line + 20; // one line + padding
    const max = line * 8 + 20;
    el.style.height = `${Math.min(max, Math.max(min, el.scrollHeight))}px`;
  }, [outText]);

  if (state.phase === "input" || state.phase === "error") {
    const doJoin = () => {
      setStoredDisplayName(displayNameInput);
      connect(roomKeyInput.trim());
    };
    return (
      <div>
        <div className="header">
          <h1>join room</h1>
          <button onClick={onExit}>&larr; rooms</button>
        </div>
        <p className="dim">
          Paste a room key to join as a browser participant. Keys never leave your browser -
          the derived auth token is computed here and sent to the relay, but the room key
          itself (and every message) stays E2E encrypted.
        </p>
        {state.phase === "error" && <p className="warn">{state.message}</p>}
        <div className="row">
          <input
            className="key-input"
            placeholder="sc_..."
            value={roomKeyInput}
            onChange={(e) => setRoomKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && roomKeyInput.trim()) doJoin();
            }}
          />
        </div>
        <div className="row">
          <input
            className="key-input"
            placeholder={`display name (default: ${email}@browser)`}
            value={displayNameInput}
            onChange={(e) => setDisplayNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && roomKeyInput.trim()) doJoin();
            }}
          />
          <button
            type="button"
            onClick={() =>
              setDisplayNameInput(`browser-${crypto.randomUUID().slice(0, 8)}`)
            }
          >
            random
          </button>
        </div>
        <div className="row">
          <button onClick={doJoin} disabled={!roomKeyInput.trim()}>
            join
          </button>
        </div>
        <p className="dim tiny">
          Your name is remembered on this device. Leave it blank to use the default.
        </p>
      </div>
    );
  }

  if (state.phase === "connecting") return <p className="dim">connecting...</p>;

  return (
    <div className="chat-room">
      <div className="chat-header">
        <div className="chat-header-main">
          <span className="chat-header-dot" title="connected" />
          <h2 className="chat-header-title">{state.roomName}</h2>
          <span className="chat-header-badge">
            <span className="dim">as</span> {state.agentId}
            <span className="role-pill">{state.role}</span>
          </span>
          <span className="chat-header-meta">
            {members.filter((m) => m.connected).length}/
            {members.filter((m) => m.state !== "banned").length} online
          </span>
        </div>
        <button onClick={onExit}>leave</button>
      </div>
      <div className="chat-grid">
        <aside className="members">
          <h4>Members</h4>
          {members.map((m) => {
            const displayOffline = stableOffline.has(m.agentId);
            return (
              <div
                key={m.agentId}
                className={`member ${displayOffline ? "off" : ""} ${m.state}`}
                title={`${m.name} (${m.platform})`}
              >
                <span className="glyph">{m.role === "master" ? "\u2605" : "\u2022"}</span>
                <span className="mid">{m.agentId}</span>
                {m.agentId === state.agentId && <span className="me"> (you)</span>}
                {m.state === "muted" && <span className="warn"> muted</span>}
                {m.state === "banned" && <span className="warn"> banned</span>}
                {displayOffline && m.state !== "banned" && (
                  <span className="dim"> offline</span>
                )}
              </div>
            );
          })}
        </aside>
        <section className="log" ref={logRef}>
          {log.length === 0 && (
            <div className="log-empty">
              <p className="dim">no activity yet</p>
              <p className="dim tiny">
                type below to ask, say, or provoke a turn on room members
              </p>
            </div>
          )}
          {log.map((entry) => (
            <div key={entry.id} className={`entry ${entry.kind} ${entry.direction}`}>
              <div className="entry-head">
                <span className="ts">
                  {new Date(entry.ts).toLocaleTimeString(undefined, { hour12: false })}
                </span>
                <span className={`kind ${entry.kind}`}>{entry.kind.toUpperCase()}</span>
                <span className="arrow">
                  {entry.direction === "out" ? "\u2192" : entry.direction === "in" ? "\u2190" : "\u00B7"}
                </span>
                <span className="peer">{entry.peer}</span>
                <span className="status">[{entry.status}]</span>
              </div>
              {entry.direction === "out" && entry.kind !== "system" ? (
                <div className="entry-body user-prompt">
                  <span className="prompt-caret">&gt;</span> {entry.text}
                </div>
              ) : (
                <div className="entry-body">{entry.text}</div>
              )}
              {[...entry.responses.entries()].map(([from, r]) => {
                const streaming = r.status === "running";
                return (
                  <div key={from} className={`response ${streaming ? "streaming" : ""}`}>
                    <div className="response-head">
                      {"\u2190 "}
                      {from} [{r.status}]
                      {streaming && <span className="pulse" aria-hidden="true" />}
                    </div>
                    <div className="response-body">
                      <ResponseBody text={r.text} />
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      </div>
      <div className="composer">
        <div className="composer-toolbar">
          <div className="kind-pills" role="tablist">
            {([
              ["ask", "ask", "they answer with LLM using their context"],
              ["say", "say", "broadcast plaintext"],
              ["turn", "turn", "provoke a real user turn on remote"],
            ] as const).map(([value, label, tip]) => (
              <button
                key={value}
                role="tab"
                aria-selected={outKind === value}
                className={`kind-pill ${outKind === value ? "active" : ""} ${value}`}
                title={tip}
                onClick={() => setOutKind(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {outKind !== "say" && targetOptions.length > 1 && (
            <div className="target-picker">
              <span className="dim tiny">to</span>
              <select value={outTarget} onChange={(e) => setOutTarget(e.target.value)}>
                {targetOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {outKind === "ask" && (
            <label className="ctx-toggle" title="send your browser context along with the ask">
              <input
                type="checkbox"
                checked={withContext}
                onChange={(e) => setWithContext(e.target.checked)}
              />
              <span>ship context</span>
            </label>
          )}
        </div>
        <div className="composer-input">
          <textarea
            ref={textareaRef}
            placeholder={
              outKind === "ask"
                ? `Ask ${outTarget === "all" ? "everyone" : outTarget}...`
                : outKind === "say"
                  ? "Say something to everyone..."
                  : `Provoke a turn on ${outTarget === "all" ? "everyone" : outTarget}...`
            }
            value={outText}
            onChange={(e) => setOutText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            autoFocus
          />
          <button
            className={`send-btn ${outText.trim() ? "ready" : ""}`}
            onClick={send}
            disabled={!outText.trim()}
            title={`send ${outKind} (enter)`}
            aria-label={`send ${outKind}`}
          >
            <span aria-hidden="true">{"\u2191"}</span>
          </button>
        </div>
        <div className="composer-hint">
          <span className="key-hint">enter</span> to send
          <span className="sep">&middot;</span>
          <span className="key-hint">shift+enter</span> newline
        </div>
      </div>
    </div>
  );
}
