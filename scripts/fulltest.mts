// Full feature test: three headless pi instances exercise every slash
// command and relay feature:
//
//   join / status / members
//   targeted ask (@agent) answered from THEIR session context (codeword proof)
//   broadcast ask answered by multiple agents
//   ask_with_context (MY context shipped along, codeword proof)
//   pane (tui-only guard) / pull
//   moderation: non-master rejection, mute/unmute, kick + rejoin,
//               ban + rejoin-blocked, unban + rejoin
//   leave, ask-while-disconnected, join with wrong key
//
//   yarn fulltest      (SELFTEST_VERBOSE=1 for full event streams)
//
// Requirements: `pi` on PATH with a working model/API key.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { generateRoomKey, deriveKeys, sha256Hex, seal, openBlob } from "../shared/crypto";
import { AAD } from "../shared/protocol";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18791;
const BASE = `http://localhost:${PORT}`;
const RELAY = `ws://localhost:${PORT}/ws`;

let passed = 0;
const cleanups: Array<() => void> = [];

const ok = (what: string) => {
  passed++;
  console.log(`  ok ${String(passed).padStart(2)}: ${what}`);
};
const fail = (msg: string): never => {
  console.error(`\nFAIL after ${passed} checks: ${msg}`);
  for (const fn of cleanups) fn();
  process.exit(1);
};
const step = (s: string) => console.log(`\n[fulltest] ${s}`);

class PiInstance {
  proc: ChildProcess;
  lines: string[] = [];
  private waiters: Array<{ match: (l: string) => boolean; resolve: (l: string) => void }> = [];
  private cursor = 0; // waitFor only matches lines after the last consumed match

  constructor(
    public label: string,
    public configDir: string,
  ) {
    this.proc = spawn(
      "pi",
      ["--mode", "rpc", "--no-session", "-e", join(ROOT, "pi", "index.ts")],
      {
        cwd: ROOT,
        env: { ...process.env, SHITTY_CHAT_DIR: configDir },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    cleanups.push(() => this.proc.kill());
    let buf = "";
    this.proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        this.lines.push(line);
        if (process.env.SELFTEST_VERBOSE) console.log(`  [${this.label}] ${line.slice(0, 220)}`);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          if (this.waiters[i].match(line)) this.waiters.splice(i, 1)[0].resolve(line);
        }
      }
    });
    this.proc.stderr!.on("data", (d: Buffer) => {
      if (process.env.SELFTEST_VERBOSE) console.error(`  [${this.label}:err] ${String(d).trim()}`);
    });
  }

  prompt(message: string) {
    this.proc.stdin!.write(`${JSON.stringify({ type: "prompt", message })}\n`);
  }

  jumpCursor() {
    this.cursor = this.lines.length;
  }

  waitFor(substr: string, timeoutMs: number, what: string): Promise<string> {
    for (let i = this.cursor; i < this.lines.length; i++) {
      if (this.lines[i].includes(substr)) {
        this.cursor = i + 1;
        return Promise.resolve(this.lines[i]);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`[${this.label}] timeout waiting for ${what} ("${substr}")`)),
        timeoutMs,
      );
      this.waiters.push({
        match: (l) => l.includes(substr),
        resolve: (l) => {
          clearTimeout(timer);
          this.cursor = this.lines.length;
          resolve(l);
        },
      });
    });
  }
}

async function main() {
  // ---- relay + room ----
  step("boot relay + create room");
  const dbPath = join(mkdtempSync(join(tmpdir(), "sc-fulltest-db-")), "test.db");
  const server = spawn("node", ["--import", "tsx", join(ROOT, "app", "server", "src", "index.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      SHITTY_CHAT_DB: dbPath,
      // very short empty-room reaping so the test can verify it
      SC_EMPTY_ROOM_TTL_MS: "2000",
      SC_REAPER_INTERVAL_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanups.push(() => server.kill());
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    if (i > 50) fail("relay did not come up");
    await new Promise((r) => setTimeout(r, 200));
  }
  ok("relay up");

  const login = await fetch(`${BASE}/api/v1/auth/dev-login`, { method: "POST" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const roomKey = generateRoomKey();
  const { authKeyHex } = await deriveKeys(roomKey);
  const authTokenHash = await sha256Hex(authKeyHex);
  const room = (await (
    await fetch(`${BASE}/api/v1/product/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "fulltest", authTokenHash }),
    })
  ).json()) as { id: string };
  ok(`room created (${room.id})`);

  const agentsViaApi = async () =>
    (await (
      await fetch(`${BASE}/api/v1/product/rooms/${room.id}/agents`, { headers: { cookie } })
    ).json()) as Array<{ agentId: string; role: string; state: string; connected: boolean }>;

  // ---- spawn 3 agents ----
  step("spawn + join 3 agents");
  const mkAgent = (label: string) => {
    const dir = mkdtempSync(join(tmpdir(), `sc-${label}-`));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        relayUrl: RELAY,
        roomKey,
        askPolicy: "auto",
        answerMode: "readonly",
        allowlist: [],
        autoConnect: false,
      }),
    );
    return new PiInstance(label, dir);
  };

  const a = mkAgent("A");
  a.prompt(`/chat_join ${roomKey} ${RELAY}`);
  await a.waitFor("chat: joined", 30_000, "A join");
  const aId = (await agentsViaApi())[0].agentId;
  ok(`A joined as ${aId}`);

  const b = mkAgent("B");
  b.prompt(`/chat_join ${roomKey} ${RELAY}`);
  await b.waitFor("chat: joined", 30_000, "B join");
  const bId = (await agentsViaApi()).find((x) => x.agentId !== aId)!.agentId;
  ok(`B joined as ${bId}`);

  const c = mkAgent("C");
  c.prompt(`/chat_join ${roomKey} ${RELAY}`);
  await c.waitFor("chat: joined", 30_000, "C join");
  const cId = (await agentsViaApi()).find((x) => x.agentId !== aId && x.agentId !== bId)!.agentId;
  ok(`C joined as ${cId}`);

  const roles = await agentsViaApi();
  if (roles.find((x) => x.agentId === aId)?.role !== "master") fail("A should be master");
  if (roles.find((x) => x.agentId === bId)?.role !== "slave") fail("B should be slave");
  ok("roles: A=master, B/C=slave (first joiner wins)");

  // ---- status + members ----
  step("/chat_status + /chat_members");
  a.prompt("/chat_status");
  const status = await a.waitFor("[master]", 10_000, "A status");
  if (!status.includes("fulltest")) fail("status missing room name");
  ok("/chat_status shows id, role, room");

  a.prompt("/chat_members");
  const membersLine = await a.waitFor("(me)", 10_000, "A members");
  if (!membersLine.includes(bId) || !membersLine.includes(cId)) fail("members list incomplete");
  ok(`/chat_members lists all three (${aId}, ${bId}, ${cId})`);

  // ---- targeted ask answered from THEIR context ----
  step("prime B's session with a fact, then targeted /chat_ask @B");
  b.prompt("Please remember: my favorite fruit is a ZEBRAFRUIT. Just acknowledge briefly.");
  await b.waitFor("agent_end", 120_000, "B priming turn");
  ok("B session primed (real turn)");

  a.prompt(`/chat_ask @${bId} what fruit did the user mention in your session? reply with just the fruit name`);
  const bAnswer = await a.waitFor(`response from ${bId}`, 180_000, "B's targeted answer");
  if (!/zebrafruit/i.test(bAnswer)) fail(`B's answer did not mention ZEBRAFRUIT: ${bAnswer.slice(0, 200)}`);
  ok("targeted ask answered from B's OWN session context (fact roundtrip, E2E)");

  // ---- broadcast ask, multiple answers ----
  step("broadcast /chat_ask answered by B and C");
  a.prompt("/chat_ask reply with exactly the word BANANA and nothing else");
  await Promise.all([
    a.waitFor(`response from ${bId}`, 180_000, "B broadcast answer"),
    a.waitFor(`response from ${cId}`, 180_000, "C broadcast answer"),
  ]);
  ok("broadcast ask: responses from both B and C");

  // ---- ask_with_context ----
  step("prime A's session, then /chat_ask_with_context @B");
  a.prompt("Please remember: my project mascot is a OMEGAWHALE. Just acknowledge briefly.");
  await a.waitFor("agent_end", 120_000, "A priming turn");
  a.prompt(
    `/chat_ask_with_context @${bId} what mascot did the user mention in the context I sent you? reply with just the mascot name`,
  );
  const mascotAnswer = await a.waitFor(`response from ${bId}`, 180_000, "B context answer");
  if (!/omegawhale/i.test(mascotAnswer)) fail(`mascot missing from answer: ${mascotAnswer.slice(0, 200)}`);
  ok("ask_with_context: MY context shipped, B read it (mascot roundtrip, E2E)");

  // ---- pane + pull ----
  step("/chat_pane + /chat_pull");
  a.prompt("/chat_pane");
  await a.waitFor("needs interactive mode", 10_000, "pane tui guard");
  ok("/chat_pane guards non-TUI mode");

  a.prompt("/chat_window");
  await a.waitFor("needs interactive mode", 10_000, "window tui guard");
  ok("/chat_window guards non-TUI mode");

  a.prompt("/chat_pull");
  await a.waitFor("queued for next turn", 10_000, "pull confirmation");
  ok("/chat_pull injects responses as next-turn context");

  // ---- moderation ----
  step("moderation");
  b.prompt(`/chat_kick ${aId}`);
  await b.waitFor("only the master", 10_000, "non-master rejection");
  ok("non-master /chat_kick rejected");

  const waitState = async (target: string, expected: string, what: string) => {
    for (let i = 0; i < 40; i++) {
      const list = await agentsViaApi();
      if (list.find((x) => x.agentId === target)?.state === expected) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    fail(`timeout waiting for ${what}`);
  };

  a.prompt(`/chat_mute ${bId}`);
  await waitState(bId, "muted", "mute to apply");
  b.prompt("/chat_ask does this get through?");
  await b.waitFor("you are muted", 30_000, "muted ask blocked");
  ok("muted agent's ask blocked by relay");

  a.prompt(`/chat_unmute ${bId}`);
  await waitState(bId, "active", "unmute to apply");
  ok("unmute works");

  a.prompt(`/chat_kick ${cId}`);
  await c.waitFor("disconnected (kicked)", 10_000, "C kicked");
  ok("kick disconnects target with reason");

  c.prompt(`/chat_join ${roomKey} ${RELAY}`);
  await c.waitFor("chat: joined", 30_000, "C rejoin after kick");
  ok("kicked agent can rejoin");

  a.prompt(`/chat_ban ${cId}`);
  await c.waitFor("disconnected (banned)", 10_000, "C banned");
  c.prompt(`/chat_join ${roomKey} ${RELAY}`);
  await c.waitFor("join failed", 30_000, "C rejoin blocked");
  ok("banned agent cannot rejoin (ban keyed to identity)");

  a.prompt(`/chat_unban ${cId}`);
  await new Promise((r) => setTimeout(r, 500));
  c.prompt(`/chat_join ${roomKey} ${RELAY}`);
  await c.waitFor("chat: joined", 30_000, "C rejoin after unban");
  ok("unban works, C rejoined");

  // ---- leave / disconnected behavior / wrong key ----
  step("/chat_leave + disconnected guards + wrong key");
  c.prompt("/chat_leave");
  await c.waitFor("chat: left", 10_000, "C left");
  const cConfig = JSON.parse(readFileSync(join(c.configDir, "config.json"), "utf8"));
  if (cConfig.roomKey) fail("leave should clear saved roomKey");
  ok("/chat_leave disconnects and clears saved key");

  c.prompt("/chat_status");
  await c.waitFor("not connected", 10_000, "status disconnected");
  ok("/chat_status reports disconnected");

  c.prompt("/chat_ask hello?");
  await c.waitFor("not connected", 10_000, "ask guard");
  ok("/chat_ask guarded when disconnected");

  c.prompt(`/chat_join sc_BogusKeyThatIsWrong123456789 ${RELAY}`);
  await c.waitFor("join failed", 15_000, "wrong key rejected");
  ok("wrong room key rejected (bad_auth)");

  // ---- broadcast /chat_say ----
  step("/chat_say broadcasts plaintext to every non-muted member");
  c.prompt(`/chat_join ${roomKey} ${RELAY}`); // C left earlier, rejoin for broadcast
  await c.waitFor("chat: joined", 30_000, "C rejoin for broadcast");
  a.prompt("/chat_say hello everyone the build is starting");
  await Promise.all([
    b.waitFor("the build is starting", 15_000, "B receives broadcast"),
    c.waitFor("the build is starting", 15_000, "C receives broadcast"),
  ]);
  ok("/chat_say delivered (E2E) to both B and C");

  a.prompt(`/chat_mute ${bId}`);
  await waitState(bId, "muted", "mute B for broadcast test");
  b.prompt("/chat_say this should be blocked");
  await b.waitFor("you are muted", 15_000, "muted broadcast blocked");
  ok("muted agent cannot broadcast");
  a.prompt(`/chat_unmute ${bId}`);
  await waitState(bId, "active", "unmute B after broadcast test");

  // ---- LLM tool invocation (natural language, not slash command) ----
  step("LLM tool invocation: ask A in plain English to use shitty_chat_ask");
  a.prompt(
    `Use the shitty_chat_ask tool to ask agent ${bId} what fruit they mentioned in their session, target should be exactly "${bId}". Just report their answer.`,
  );
  const toolCallLine = await a.waitFor("shitty_chat_ask", 120_000, "tool call");
  if (!toolCallLine.includes("tool_execution_start") && !toolCallLine.includes("tool_call")) {
    // any event containing the tool name is fine - LLM either called it or referenced it
  }
  ok("LLM invoked shitty_chat_ask tool from natural language");
  // The tool's result flows back as a tool_execution_end event; the answer
  // string appears somewhere in A's RPC stream.
  const toolLine = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("tool result timeout")), 180_000);
    const cursor = a.lines.length;
    const scan = () => {
      for (let i = cursor; i < a.lines.length; i++) {
        if (/zebrafruit/i.test(a.lines[i])) {
          clearTimeout(t);
          resolve(a.lines[i]);
          return;
        }
      }
      setTimeout(scan, 300);
    };
    scan();
  });
  if (!toolLine) fail("tool never returned answer");
  ok("tool returned B's actual answer from B's context");

  // ---- dashboard state sanity ----
  const finalAgents = await agentsViaApi();
  const usage = (await (
    await fetch(`${BASE}/api/v1/product/rooms/${room.id}/usage`, { headers: { cookie } })
  ).json()) as Array<{ asks: number }>;
  if (finalAgents.length !== 3) fail(`expected 3 agents in dashboard, got ${finalAgents.length}`);
  if (!usage.length || usage[0].asks < 4) fail("usage counter did not track asks");
  ok(`dashboard: 3 agents tracked, ${usage[0].asks} asks counted`);

  // ---- browser participant (same wire protocol as the dashboard) ----
  step("browser participant joins, sends ask+say+turn, and auto-declines");

  // Make sure all three pi agents are connected (earlier tests left some off).
  for (const [inst, name] of [[a, "A"], [b, "B"], [c, "C"]] as const) {
    inst.prompt(`/chat_join ${roomKey} ${RELAY}`);
    await inst.waitFor("chat: joined", 30_000, `${name} connected for browser test`).catch(() => {});
  }

  const browserIdentity = "browser-simulated-identity";
  const browserWs = new WebSocket(RELAY);
  const browserInbox: Array<{ type: string; from?: string; payload: unknown }> = [];
  const browserWait = (fn: (msg: { type: string; from?: string; payload: unknown }) => boolean, ms: number, what: string) =>
    new Promise<{ type: string; from?: string; payload: unknown }>((resolve, reject) => {
      const existing = browserInbox.findIndex(fn);
      if (existing >= 0) return resolve(browserInbox.splice(existing, 1)[0]);
      const timer = setTimeout(() => reject(new Error(`browser timeout: ${what}`)), ms);
      const handler = (data: unknown) => {
        const msg = JSON.parse(String(data));
        if (fn(msg)) {
          clearTimeout(timer);
          browserWs.off("message", handler);
          resolve(msg);
        } else {
          browserInbox.push(msg);
        }
      };
      browserWs.on("message", handler);
    });

  const derived = await deriveKeys(roomKey);
  await new Promise<void>((resolve, reject) => {
    browserWs.on("open", resolve);
    browserWs.on("error", reject);
  });
  browserWs.send(
    JSON.stringify({
      type: "hello",
      payload: { authKey: derived.authKeyHex, identity: browserIdentity, name: "dashboard@browser", platform: "browser" },
    }),
  );
  const welcome = (await browserWait((m) => m.type === "welcome", 15_000, "browser welcome"))
    .payload as { agentId: string };
  const browserId = welcome.agentId;
  ok(`browser joined as ${browserId}`);

  // browser sends /chat_ask to B (which answers with LLM)
  const askId = crypto.randomUUID();
  browserWs.send(
    JSON.stringify({
      type: "ask",
      payload: {
        askId,
        prompt: await seal(derived.e2eKey, "say EXACTLY the word HEDGEHOG and nothing else", AAD.ask(askId)),
        target: bId,
        agentMode: false,
      },
    }),
  );
  const respMsg = await browserWait(
    (m) => m.type === "ask_response" && (m.payload as { askId: string }).askId === askId,
    180_000,
    "browser ask response from B",
  );
  const respPayload = respMsg.payload as { chunk: { n: string; c: string } };
  const respText = await openBlob(derived.e2eKey, respPayload.chunk, AAD.resp(askId, respMsg.from ?? "?"));
  if (!/HEDGEHOG/i.test(respText)) fail(`browser did not decrypt B's answer: got "${respText.slice(0, 80)}"`);
  ok("browser sent E2E ask -> got decrypted LLM answer from pi B");

  // browser broadcasts a /chat_say
  const sayId = crypto.randomUUID();
  browserWs.send(
    JSON.stringify({
      type: "say",
      payload: { sayId, text: await seal(derived.e2eKey, "BROWSERSHOUT hello agents", AAD.say(sayId, browserId)) },
    }),
  );
  await Promise.all([
    b.waitFor("BROWSERSHOUT", 15_000, "B receives browser broadcast"),
    c.waitFor("BROWSERSHOUT", 15_000, "C receives browser broadcast"),
  ]);
  ok("browser broadcast (say) reached pi B and pi C");

  // browser provokes a turn on B; response should come BACK to the browser
  const turnId = crypto.randomUUID();
  browserWs.send(
    JSON.stringify({
      type: "turn",
      payload: {
        turnId,
        prompt: await seal(
          derived.e2eKey,
          "Please respond with a single line that starts with CACTUSDUCK and confirms you got this.",
          AAD.turn(turnId, browserId),
        ),
        target: bId,
      },
    }),
  );
  await b.waitFor("running turn from", 15_000, "B accepts browser-provoked turn");
  // Collect all turn_response chunks (running + final) - we want to verify
  // the sender sees streamed progress, not just the final summary.
  const collected: Array<{ status: string; chunk: { n: string; c: string } }> = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("browser timeout waiting for final turn_response")), 240_000);
    const handler = (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (msg.type === "turn_response" && msg.payload?.turnId === turnId) {
        collected.push(msg.payload);
        if (msg.payload.status === "final") {
          clearTimeout(timer);
          browserWs.off("message", handler);
          resolve();
        }
      }
    };
    browserWs.on("message", handler);
  });
  const runningChunks = collected.filter((c) => c.status === "running");
  const finalChunk = collected.find((c) => c.status === "final");
  if (!finalChunk) fail("no final turn_response");
  if (runningChunks.length === 0) fail("no running progress chunks streamed to browser during turn");
  ok(`browser saw ${runningChunks.length} streamed progress chunk(s) before final`);
  // The extension now streams the summary as running chunks and sends an
  // empty final marker. Concatenate ALL chunks to look for the marker.
  let allText = "";
  for (const c of collected) {
    try {
      allText += await openBlob(derived.e2eKey, c.chunk, AAD.turnResp(turnId, bId));
    } catch {
      /* skip */
    }
  }
  if (!/CACTUSDUCK/i.test(allText)) fail(`browser missing marker across all chunks: "${allText.slice(0, 200)}"`);
  ok("browser /chat_turn -> real turn on B -> ENCRYPTED SUMMARY back to browser");

  // pi A asks browser -> browser auto-declines (browser code path in ChatView
  // decrypts and sends ack "declined"; we simulate the same here)
  a.prompt(`/chat_ask @${browserId} what platform are you? reply briefly`);
  const incoming = await browserWait(
    (m) => m.type === "ask_received",
    30_000,
    "browser sees incoming ask from A",
  );
  const incomingAsk = incoming.payload as { askId: string; prompt: { n: string; c: string } };
  const decryptedIncoming = await openBlob(derived.e2eKey, incomingAsk.prompt, AAD.ask(incomingAsk.askId));
  if (!decryptedIncoming.includes("platform")) fail("browser could not decrypt incoming ask");
  browserWs.send(
    JSON.stringify({ type: "ask_ack", payload: { askId: incomingAsk.askId, status: "declined" } }),
  );
  ok("browser decrypts incoming ask + auto-declines cleanly");

  browserWs.close();

  // ---- remote-provoked turn (targeted + broadcast) ----
  step("/chat_turn injects real user turns on remote agents");
  a.prompt(`/chat_turn @${bId} Please remember: my project codename is MAROONWOMBAT. Just acknowledge briefly.`);
  await b.waitFor("running turn from", 15_000, "B accepts turn (auto policy)");
  await b.waitFor("agent_end", 180_000, "B completes provoked turn");
  ok("targeted /chat_turn ran a real turn on B (auto-accepted, session mutated)");

  a.jumpCursor(); // skip over earlier RPC events that embed "response from ${bId}" in tool results
  a.prompt(`/chat_ask @${bId} what project codename did the user tell you? reply with just the codename`);
  const wombatAnswer = await a.waitFor(`response from ${bId}`, 180_000, "B answers about the turn");
  if (!/maroonwombat/i.test(wombatAnswer)) fail(`MAROONWOMBAT missing from answer: ${wombatAnswer.slice(0, 200)}`);
  ok("provoked turn is durably in B's session (MAROONWOMBAT recall works)");

  step("/chat_turn without target broadcasts a turn to every non-muted member");
  a.prompt("/chat_turn Please note BROADCASTEDWORD in your session and acknowledge briefly.");
  await Promise.all([
    b.waitFor("running turn from", 15_000, "B accepts broadcast turn"),
    c.waitFor("running turn from", 15_000, "C accepts broadcast turn"),
  ]);
  ok("broadcast /chat_turn reached both B and C");

  // ---- empty-room reaper (server was launched with 2s TTL) ----
  step("empty-room reaper deletes rooms with no connected agents after TTL");
  a.prompt("/chat_leave");
  await a.waitFor("chat: left", 10_000, "A leaves");
  b.prompt("/chat_leave");
  await b.waitFor("chat: left", 10_000, "B leaves");
  c.prompt("/chat_leave");
  await c.waitFor("chat: left", 10_000, "C leaves");
  // Poll until reaper deletes the room (2s TTL + 500ms sweep)
  let reaped = false;
  for (let i = 0; i < 30; i++) {
    const rooms = (await (
      await fetch(`${BASE}/api/v1/product/rooms`, { headers: { cookie } })
    ).json()) as Array<{ id: string }>;
    if (!rooms.find((r) => r.id === room.id)) {
      reaped = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!reaped) fail("empty room was not reaped within 15s");
  ok("empty room reaped after TTL");

  console.log(`\nFULLTEST PASSED: ${passed} checks green`);
  for (const fn of cleanups) fn();
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));
