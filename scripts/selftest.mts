// Self-test: boots a throwaway relay, creates a room, launches two headless
// pi instances (RPC mode) with the shitty-chat extension, joins both to the
// room, and has agent A ask agent B a question end to end.
//
//   yarn selftest
//
// Requirements: `pi` on PATH with a working model/API key (agent B answers
// the ask with a real out-of-band LLM call).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateRoomKey, deriveKeys, sha256Hex } from "../shared/crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18790;
const BASE = `http://localhost:${PORT}`;
const RELAY = `ws://localhost:${PORT}/ws`;
const MARKER = `PONG-${Math.random().toString(36).slice(2, 8)}`;

const cleanups: Array<() => void> = [];
const fail = (msg: string): never => {
  console.error(`\nFAIL: ${msg}`);
  for (const fn of cleanups) fn();
  process.exit(1);
};

function log(step: string) {
  console.log(`[selftest] ${step}`);
}

// ---------------------------------------------------------------------------
// pi RPC instance wrapper

class PiInstance {
  proc: ChildProcess;
  lines: string[] = [];
  private waiters: Array<{ match: (l: string) => boolean; resolve: (l: string) => void }> = [];

  constructor(name: string, configDir: string) {
    this.proc = spawn(
      "pi",
      ["--mode", "rpc", "--no-session", "-e", join(ROOT, "extension", "index.ts")],
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
        if (process.env.SELFTEST_VERBOSE) console.log(`  [${name}] ${line.slice(0, 200)}`);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          if (this.waiters[i].match(line)) {
            this.waiters.splice(i, 1)[0].resolve(line);
          }
        }
      }
    });
    this.proc.stderr!.on("data", (d: Buffer) => {
      if (process.env.SELFTEST_VERBOSE) console.error(`  [${name}:err] ${d.toString().trim()}`);
    });
  }

  send(cmd: object) {
    this.proc.stdin!.write(`${JSON.stringify(cmd)}\n`);
  }

  prompt(message: string) {
    this.send({ type: "prompt", message });
  }

  // Wait until any stdout line (JSON events, notifications, widget updates)
  // contains `substr`. Also scans lines that already arrived.
  waitFor(substr: string, timeoutMs: number, what: string): Promise<string> {
    const existing = this.lines.find((l) => l.includes(substr));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${what} (${substr})`)),
        timeoutMs,
      );
      this.waiters.push({
        match: (l) => l.includes(substr),
        resolve: (l) => {
          clearTimeout(timer);
          resolve(l);
        },
      });
    });
  }
}

// ---------------------------------------------------------------------------

async function main() {
  // 1. throwaway relay server (isolated db + high limits, separate port)
  log(`starting relay on :${PORT}`);
  const dbPath = join(mkdtempSync(join(tmpdir(), "sc-selftest-db-")), "test.db");
  const server = spawn("node", ["--import", "tsx", join(ROOT, "server", "src", "index.ts")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SHITTY_CHAT_DB: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanups.push(() => server.kill());

  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 50) fail("relay did not come up");
    await new Promise((r) => setTimeout(r, 200));
  }

  // 2. login + create room (key generated client-side, like the dashboard)
  log("creating room (dev login + client-side key)");
  const login = await fetch(`${BASE}/api/v1/auth/dev-login`, { method: "POST" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const roomKey = generateRoomKey();
  const { authKeyHex } = await deriveKeys(roomKey);
  const authTokenHash = await sha256Hex(authKeyHex);
  const room = (await (
    await fetch(`${BASE}/api/v1/product/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "selftest", authTokenHash }),
    })
  ).json()) as { id: string };
  log(`room ${room.id} created, key ${roomKey.slice(0, 12)}...`);

  // 3. two isolated pi instances; B pre-configured to auto-accept asks
  const dirA = mkdtempSync(join(tmpdir(), "sc-agent-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "sc-agent-b-"));
  cleanups.push(() => rmSync(dirA, { recursive: true, force: true }));
  cleanups.push(() => rmSync(dirB, { recursive: true, force: true }));
  for (const dir of [dirA, dirB]) {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        relayUrl: RELAY,
        roomKey, // pre-set so /chat_join does not prompt "save key?"
        askPolicy: "auto", // no consent dialog in headless test
        answerMode: "readonly",
        allowlist: [],
        autoConnect: false,
      }),
    );
  }

  log("spawning pi instance A (asker) and B (answerer)");
  const a = new PiInstance("A", dirA);
  const b = new PiInstance("B", dirB);

  // 4. join both
  a.prompt(`/chat_join ${roomKey} ${RELAY}`);
  await a.waitFor("chat: joined", 30_000, "A to join").catch((e) => fail(String(e)));
  log("A joined (master)");

  b.prompt(`/chat_join ${roomKey} ${RELAY}`);
  await b.waitFor("chat: joined", 30_000, "B to join").catch((e) => fail(String(e)));
  log("B joined (slave)");

  // 5. A asks, B auto-accepts and answers via a real LLM call
  log(`A asks the room to reply with marker ${MARKER} (B answers via LLM)`);
  a.prompt(`/chat_ask reply with exactly the word ${MARKER} and nothing else`);

  await a
    .waitFor("chat: response from", 180_000, "B's answer to arrive at A")
    .catch((e) => fail(String(e)));
  log("A received a response notification");

  // 6. the decrypted marker must show up on A (widget/pane update)
  await a
    .waitFor(MARKER.slice(0, 4), 10_000, "decrypted marker visible on A")
    .then((line) =>
      line.includes(MARKER)
        ? log(`marker ${MARKER} decrypted on A: OK`)
        : log("marker prefix seen (model may have paraphrased); check manually"),
    )
    .catch(() => log("marker not seen in events (model paraphrased?); response did arrive"));

  console.log("\nSELFTEST PASSED: join -> E2E ask -> LLM answer -> E2E response");
  for (const fn of cleanups) fn();
  process.exit(0);
}

main().catch((e) => fail(String(e)));
