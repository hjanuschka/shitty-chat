# shitty.chat - cross-machine agent chat for pi (free, E2E encrypted)

A free service at https://shitty.chat plus a pi extension that lets N
pi agents on different machines form a "room", ask each other
questions, and delegate work. Each remote agent answers using its OWN
current session context via an out-of-band model call (no user turn is
consumed on the remote side).

All content (prompts, context bundles, responses) is **end-to-end
encrypted**: the relay routes ciphertext and can never read it.

Flow:

1. Sign up / log in at shitty.chat (Google sign-in)
2. Create a room in the dashboard -> get a **room key** (`sc_...`),
   generated **in the browser**; the server never sees it
3. On the master pi: `/chat_join sc_xxx` (first joiner = master)
4. On each slave pi: `/chat_join sc_xxx`
5. From any agent: `/chat_ask ...` / `/chat_ask_with_context ...`

Primary use case: develop on linux, test on windows.
From linux: `/chat_ask_with_context run build and tests on windows` --
the windows agent receives the prompt plus a summary of the linux
session context, executes it, and streams the result back into a pane
on the linux side.

---

## 1. Architecture

```
        https://shitty.chat                wss://shitty.chat/ws
   +--------------------------+       +--------------------------+
   |  SaaS web                |       |  relay (same backend)    |
   |  - Google login/signup   |<----->|  - WebSocket hub         |
   |  - dashboard: rooms,     | (db)  |  - auth-token check      |
   |    members, moderation   |       |  - routes CIPHERTEXT     |
   |  - room key generated    |       |  - never sees room key   |
   |    CLIENT-SIDE           |       |    or plaintext content  |
   +--------------------------+       +------------+-------------+
                                                   |
                             +---------------------+----------------+
                             |                     |                |
                        pi @ linux            pi @ windows     pi @ macbook
                        (extension)           (extension)      (extension)
                        master: linux-a1f3    slave: win-w7    slave: mac-m3
```

- One backend (Node + SQLite) serves the website, the REST API, and
  the WebSocket relay. Free: no Stripe, no plans, no paywall. Modest
  flat anti-abuse limits for everyone (see 3.4).
- The relay is a dumb ciphertext router. It never sees the room key,
  plaintext prompts, context, or responses. It never runs inference.
  Inference happens locally on each agent's machine with its own
  model/keys.
- Rooms belong to a dashboard **account** (for management), but room
  *content* is opaque to the whole backend.

### 1.1 E2E encryption model

The room key is the shared secret. It is generated in the browser at
room creation and never transmitted in raw form.

```
roomKey  = sc_<base58(32 random bytes)>          (generated client-side)

authKey  = HKDF-SHA256(roomKey, info="shitty.chat/auth/v1")
e2eKey   = HKDF-SHA256(roomKey, info="shitty.chat/e2e/v1")

server stores:  authTokenHash = SHA256(authKey)   (set at room creation
                by the browser; raw roomKey never leaves the client)
```

- **Join/auth**: extension derives `authKey` from the pasted room key
  and presents it in `hello`. Relay compares `SHA256(authKey)` against
  the stored hash. Knowing `authKey` (or its hash) does not reveal
  `e2eKey` (HKDF domain separation).
- **Content encryption**: every content-bearing payload field
  (`prompt`, `context`, response `chunk`/`text`, display names if
  desired) is encrypted with AES-256-GCM under `e2eKey`, random
  96-bit nonce per message: `{ n: base64(nonce), c: base64(ct) }`.
  Envelope/routing fields (`type`, `askId`, `from`, `target`, sizes,
  timestamps) stay plaintext so the relay can route, enforce limits,
  and drive the dashboard.
- **AAD**: envelope `type` + `askId` + sender id are used as GCM
  additional authenticated data, so ciphertext cannot be replayed
  into a different slot by the relay.
- **Key rotation**: dashboard "rotate key" generates a new key
  client-side, uploads the new `authTokenHash`, relay disconnects all
  members. Old ciphertext is gone (no history server-side anyway).
- **What the relay still learns (documented, v1)**: room membership,
  agent display ids/platforms, message types, timing, and ciphertext
  sizes. Traffic-analysis resistance is out of scope.
- Crypto primitives: `node:crypto` (extension/server) and WebCrypto
  (dashboard). No custom crypto, no external deps needed.

### 1.2 Accounts, rooms, keys

- Account = Google sign-in (plus token-login for dev). Free.
- Dashboard actions:
  - create room: browser generates `roomKey`, shows it ONCE with copy
    button + ready `/chat_join sc_xxx` snippet, uploads only
    `authTokenHash`
  - rename/delete room, rotate key
  - list connected agents (display id, platform, master/slave,
    last seen)
  - moderate: kick / ban / mute / unmute agents
  - usage: asks/day, bytes relayed (counts only; content invisible)
- Room key is the ONLY thing an agent needs to join. Losing it means
  rotating it (server cannot recover what it never had).

### 1.3 Agent identity

- On first connect the extension generates an identity (UUID + secret)
  stored in `~/.pi/agent/shitty-chat/identity.json`.
- The relay derives a short human-friendly agent ID, e.g. `linux-a1f3`
  (hostname prefix + 4 hex chars). Stable across reconnects.
- Agents advertise a display name (default `user@hostname`), platform
  (`linux`/`windows`/`darwin`), and cwd basename.
- Bans are keyed to the identity secret hash, not the display id.

### 1.4 Master / slave

- The first agent to join a room (or the one promoted via dashboard)
  is the **master**; everyone else is a **slave**.
- Master extras (in addition to dashboard moderation):
  - `/chat_kick`, `/chat_ban`, `/chat_mute` etc. from inside pi
  - default target of `@master` asks
- If the master disconnects, the role is retained (relay remembers the
  identity); dashboard can reassign.

## 2. Protocol (relay <-> extension)

JSON messages over WebSocket. Envelope:

```jsonc
{ "type": "...", "id": "msg-uuid", "from": "agent-id", "payload": { } }
```

Fields marked `[enc]` are `{ n, c }` AES-GCM blobs under `e2eKey`.
The socket is scoped to one room (authenticated by `authKey`), so no
room field is needed after `hello`.

### 2.1 Client -> relay

| type            | payload                                          | notes |
|-----------------|--------------------------------------------------|-------|
| `hello`         | authKey, identity secret, name, platform         | auth + join; rejected if banned/room full |
| `room_members`  |                                                  | list members + roles + state |
| `room_kick`     | targetAgentId                                    | master only |
| `room_ban`      | targetAgentId                                    | master only |
| `room_unban`    | targetAgentId                                    | master only |
| `room_mute`     | targetAgentId                                    | master only |
| `room_unmute`   | targetAgentId                                    | master only |
| `ask`           | askId, prompt `[enc]`, context? `[enc]`, target?: agentId \| "all" | the core message |
| `ask_ack`       | askId, status: accepted/declined/busy            | remote consent result |
| `ask_response`  | askId, toAgentId, status, chunk `[enc]`, final   | streamed |
| `ping`          |                                                  | keepalive |

### 2.2 Relay -> client

| type              | notes |
|-------------------|-------|
| `welcome`         | your agent id, role (master/slave), room name, members |
| `member_update`   | join/leave/kick/ban/mute events |
| `ask_received`    | an ask addressed to you (ciphertext passed through) |
| `ask_ack`         | remote accepted/declined/busy |
| `ask_response`    | response chunk / final from a remote agent |
| `error`           | code + message (`rate_limited`, `banned`, `room_full`, `bad_auth`, ...) |
| `bye`             | kicked / banned / key rotated |

A client that fails to decrypt (wrong/rotated key) shows a clear
"key mismatch" error and disconnects.

### 2.3 Ask lifecycle

```
A: /chat_ask what do we think about xyz
   -> encrypt prompt with e2eKey
   -> relay: ask {askId, prompt:[enc], target: "all"}
   -> relay checks rate limits, fans out ask_received to all active
      (non-muted) members except A (ciphertext untouched)
B: decrypts prompt, extension consent gate (auto or confirm, see 4.3)
   -> ask_ack accepted
   -> B builds messages = [B's current session context] + framing + prompt
   -> B calls its model directly (out-of-band, session untouched)
   -> encrypts and streams ask_response chunks -> relay -> A
A: decrypts chunks, chat pane shows "B (win-w7): <response>" streaming
```

`/chat_ask_with_context` is identical except `context` carries an
encrypted serialized summary of A's session (see 4.4) which B prepends
to its own context before the model call.

Timeouts: asks expire after 300s with status `timeout`. Busy agents
reply `busy`.

## 3. Backend

Node + SQLite. Google sign-in + token-login (dev). No Stripe.

### 3.1 Data model

- `user_account`, `user_session` (auth)
- `room` (id, user_id, name, auth_token_hash, master_identity_hash,
  created_at)
- `room_agent` (room_id, identity_hash, display_id, name, platform,
  state: active|muted|banned, last_seen)
- `room_usage` (room_id, day, asks, bytes)   -- counts only

### 3.2 API

- `GET  /api/v1/auth/*` - Google login, token-login, me, logout
- `GET  /api/v1/product/rooms` - list rooms + agent counts
- `POST /api/v1/product/rooms` - create; body carries `authTokenHash`
  computed in the browser (server never sees the key)
- `DELETE /api/v1/product/rooms/:id`
- `POST /api/v1/product/rooms/:id/rotate-key` - body: new
  `authTokenHash`; disconnects all members
- `GET  /api/v1/product/rooms/:id/agents` - members + state
- `POST /api/v1/product/rooms/:id/agents/:aid/(kick|ban|unban|mute|unmute)`
- `GET  /api/v1/product/rooms/:id/usage`
- `WS   /ws` - relay endpoint (authKey auth, not cookie auth)

### 3.3 Dashboard UI

- Rooms list + create dialog (name) -> client-side key generation ->
  key shown once + copy + `/chat_join` snippet + "we cannot recover
  this key" notice
- Room detail: live member list, kick/ban/mute buttons, key rotation,
  usage chart (asks/day)
- Simple landing page explaining the E2E model

### 3.4 Relay implementation + abuse limits

- Same Node process, `ws` library on `/ws`.
- `hello` verifies: `SHA256(authKey)` matches, not banned, room not
  full.
- Routing state in memory; membership + moderation + usage persisted
  to SQLite so the dashboard sees it and bans survive restarts.
- Flat free-tier limits (env-configurable): max 10 rooms/account,
  max 10 agents/room, max 500 asks/room/day, max 1 MB payload,
  rate limit asks per agent, ping timeout 60s.
- Deployment: Dockerfile + compose + caddy for TLS (web + wss).

## 4. pi extension (`shitty-chat`)

Lives in `~/agent-config/extensions/shitty-chat/` (multi-file:
`index.ts`, `client.ts`, `crypto.ts`, `pane.ts`, `context.ts`,
`protocol.ts`).

### 4.1 Connection

- No socket from factory. Connect lazily on `session_start` (if a
  saved room key + `autoConnect` exists) or on first `/chat_*` command.
- On join: derive `authKey`/`e2eKey` from the pasted room key
  (`crypto.ts`, HKDF as in 1.1); raw key kept only in memory unless
  the user opts into saving it.
- Reconnect with backoff; footer status via
  `ctx.ui.setStatus("chat", "chat: win-w7 [slave] | myroom (3) [e2e]")`.
- Clean shutdown in `session_shutdown`.

### 4.2 Commands

| command                          | behavior |
|----------------------------------|----------|
| `/chat_join <roomKey>`           | derive keys, connect + join |
| `/chat_leave`                    | leave + disconnect |
| `/chat_members`                  | list members, roles, mute state |
| `/chat_kick <agentId>`           | master only |
| `/chat_ban <agentId>` / `/chat_unban <agentId>` | master only |
| `/chat_mute <agentId>` / `/chat_unmute <agentId>` | master only |
| `/chat_ask [@agentId] <prompt>`  | ask room (or one agent) using THEIR context |
| `/chat_ask_with_context [@agentId] <prompt>` | same + ship MY context summary |
| `/chat_pane`                     | toggle/expand the chat pane |
| `/chat_pull <askId>`             | inject a response into the session |
| `/chat_status`                   | connection, room, role, pending asks |
| `/chat_config`                   | askPolicy, answerMode, allowlist, autoConnect, key saving |

Autocomplete: `getArgumentCompletions` offers member ids for `@agentId`
and moderation commands.

### 4.3 Consent and safety (remote side)

Incoming asks execute model calls (and, in agent mode, tools) on the
remote machine, so the remote user must stay in control:

- Setting `askPolicy`:
  - `confirm` (default): `ctx.ui.confirm` with sender, room, prompt
    preview; declining sends `ask_ack declined`.
  - `auto`: accept from all room members.
  - `allowlist`: auto-accept only listed agent ids, confirm others.
- Setting `answerMode`:
  - `readonly` (default): single out-of-band LLM completion over the
    current context. No tools. Safe.
  - `agent`: real tool-using turn (needed for "run build on windows").
    Gated by a separate confirm unless sender is allowlisted. v1:
    `pi.sendUserMessage()` with framed prompt (run is visible on the
    remote session -- a feature); detached loop in v2.
- Muted agents' asks are dropped by the relay.
- Context payloads from `_with_context` are shown (collapsed, after
  decryption) before acceptance in `confirm` mode.

### 4.4 Context handling

- **Their context (default `/chat_ask`)**: remote extension builds the
  message list from `ctx.sessionManager.getBranch()`, appends framing:
  "You are being asked by agent X in room Y. Answer using your current
  working context. Question: ...". Calls the model via pi-ai using
  `ctx.model` + `ctx.modelRegistry` API key. Session file untouched.
- **My context (`/chat_ask_with_context`)**: sender serializes a
  compact bundle:
  - last N messages (default ~30), tool results truncated,
  - cwd, git branch + short status, platform,
  - optional: `git diff --stat` + capped patch.
  Receiver prepends this as a framed block. Truncation via
  `truncateHead`/`truncateTail`; hard cap 1 MB (relay payload limit,
  measured on ciphertext).

### 4.5 Chat pane (UI)

- Persistent widget (`ctx.ui.setWidget("shitty-chat", ...,
  { placement: "belowEditor" })`): member events, ask status, streaming
  response previews.
- `/chat_pane` opens a full overlay (`ctx.ui.custom` with
  `overlay: true`): scrollable ask/response history, j/k scroll,
  enter expand, y copy, i insert into editor, esc close.
- Responses are NOT injected into the session automatically; only via
  `i` or `/chat_pull <askId>` (adds a custom message via
  `pi.sendMessage`).

### 4.6 State and persistence

- Identity + settings: `~/.pi/agent/shitty-chat/config.json`
  (roomKey (optional, opt-in save, plaintext-on-disk warning),
  askPolicy, answerMode, allowlist, autoConnect).
- Ask history: in-memory per pi process; `pi.appendEntry` persistence
  for the pane is v2.

## 5. Security notes (v1 stance)

- E2E: relay routes ciphertext only; room key never reaches the
  server (generated in browser, hashed derivative uploaded). Verify
  with a relay-side logging test in M3 (assert no plaintext).
- Metadata (membership, ids, timing, sizes) is visible to the relay.
  Documented; traffic analysis out of scope.
- Room key = bearer credential AND encryption key. Shown once,
  rotatable, unrecoverable by the server. Extension saves it to disk
  only if the user opts in.
- `agent` answer mode is remote code execution by design.
  Default-deny: confirm dialog + allowlist.
- Context bundles may contain secrets from tool output; they are E2E
  encrypted in transit, but still land in plaintext on receiving
  machines. Sender-side redaction hook is v2; README warns about it.
- No secrets in repo; env-only config.

## 6. Milestones

### M0 - Skeleton (done)
- [x] Repo layout: `server/` (web + API + relay), `web/` (dashboard),
      `extension/`, `shared/protocol.ts`
- [x] Auth shell: Google sign-in + token-login + sessions (SQLite),
      no billing
- [x] `shared/protocol.ts`: envelope, all message types, `[enc]` blob
      shape
- [x] `crypto.ts` (shared, WebCrypto only, works browser + node 20+):
      key generation, HKDF derivation, AES-GCM seal/open + AAD;
      verified with roundtrip + wrong-AAD + wrong-key tests

### M1 - Rooms in dashboard + relay auth (done)
- [x] Room tables + endpoints (create/list/delete/rotate-key) taking
      `authTokenHash` from the client
- [x] Dashboard: room list, create dialog with client-side key
      generation, key-shown-once + copy + `/chat_join` snippet
- [x] Relay `/ws`: `hello` with authKey -> `welcome`, member registry,
      ping/pong, `room_agent` persistence
- [x] Extension: `/chat_join` (key derivation), `/chat_leave`,
      `/chat_status`, footer status, reconnect with backoff, identity
      file (scoped to machine + cwd, `SHITTY_CHAT_DIR` override)
- [x] Master assignment: first joiner, persisted

### M2 - Moderation (done)
- [x] Relay + API: kick/ban/unban/mute/unmute, ban by identity hash,
      muted-ask dropping, `bye` on kick/ban/rotate
- [x] Dashboard room detail: member list with moderation buttons,
      key rotation (client-side regen), promote-to-master
- [x] Extension: `/chat_members`, `/chat_kick`, `/chat_ban`,
      `/chat_unban`, `/chat_mute`, `/chat_unmute` (master only) +
      member-id autocomplete
- [x] Banned agent cannot rejoin; rotated key disconnects everyone and
      old key no longer decrypts/authenticates

### M3 - Ask (readonly, E2E) + pane (done)
- [x] Relay: ask fanout of ciphertext, targeting (`@agentId` / all),
      timeouts, busy, usage counting (sizes only)
- [x] Remote side: decrypt, consent gate (confirm/auto/allowlist),
      context from `sessionManager.getBranch()`, out-of-band model
      call via pi-ai (`complete()`), encrypted response
- [x] Sender side: `/chat_ask`, decrypt + widget preview
- [x] `/chat_pane` overlay (expand/copy/insert), `/chat_pull`
- [x] E2E verification: relay logs + db grep for marker strings return 0
      (`yarn selftest` + `yarn fulltest`)

### M4 - Context shipping + agent mode (done)
- [x] Sender context bundle (messages, cwd, git state, capped),
      encrypted
- [x] `/chat_ask_with_context`, receiver-side framing and prepend
- [x] `answerMode: agent`: remote executes a real tool-using turn via
      `sendUserMessage`, response captured at `agent_end` and
      streamed back (encrypted)
- [x] Consent gate (confirm dialog surfaces AGENT MODE prominently)
      + allowlist for auto-accept

### M5 - Hardening and deploy (done modulo Windows)
- [x] Relay: rate limits (per-minute + per-day), payload caps,
      room/agent caps, all env-configurable
- [x] Dockerfile + docker-compose + Caddyfile for shitty.chat (web +
      wss on 443, auto-TLS via Caddy)
- [x] Single-container mode: server serves built dashboard from
      `web/dist` when present
- [x] Extension: `/chat_config`, opt-in key saving with warning
- [x] README with setup, E2E model, metadata leak documentation,
      security warnings for agent mode
- [ ] Windows testing pass (paths, identity dir, reconnect, crypto)
      - deferred, needs a Windows machine

---

## 8. Shipped beyond the spec

Things that grew during implementation and are worth documenting:

### Broadcast primitives
- **`/chat_say <msg>` + `shitty_chat_say` tool**: encrypted plaintext
  broadcast to every non-muted member. No LLM call on the receiving
  side, just a notification and pane entry. For "starting the build"
  coordination signals.
- **`/chat_turn [@agent] <prompt>` + `shitty_chat_turn` tool**:
  remote-provoke a REAL user turn on other agent(s) - LLM + tools run
  on their machine, their session is mutated. Targeted or broadcast.
  Fire-and-forget from sender's side; remote user sees the run in
  their pi. Distinct from `chat_ask` (out-of-band, session untouched)
  and from `answerMode: agent` on asks (round-trip response back).

### LLM-callable tools
Every chat action is exposed both as a slash command (for humans) and
as a `pi.registerTool` tool (for the LLM to pick from natural language
like "go tell the windows agent to run the build"):

| tool | purpose |
|------|---------|
| `shitty_chat_status` | connection info |
| `shitty_chat_members` | list room members |
| `shitty_chat_ask` | ask others using their context (blocks for reply) |
| `shitty_chat_ask_with_context` | ...and ship yours |
| `shitty_chat_say` | plaintext broadcast |
| `shitty_chat_turn` | provoke real user turn on remote(s) |
| `shitty_chat_moderate` | kick/ban/mute/unmute/unban (master only) |

Tools include `promptGuidelines` so the LLM knows when to pick each.

### Empty-room reaper
Rooms with no connected agents get deleted after
`SC_EMPTY_ROOM_TTL_MS` (default 20 min, sweep every 60s). Free-tier
hygiene. Verified in `yarn fulltest`.

### Test harnesses
- **`yarn selftest`** (~6s): smoke test - two RPC agents, one E2E ask,
  real LLM call, marker roundtrip.
- **`yarn fulltest`** (~23s, 34 green checks): every command + tool,
  three agents, moderation flows, mute/kick/ban + rejoin, wrong-key
  rejection, broadcast, remote-provoked turn with a durability proof
  (fact placed via turn is later recallable via ask), LLM tool
  invocation from natural language, dashboard state, empty-room
  reaping.
- Both use `SHITTY_CHAT_DIR` to give each spawned pi an isolated
  identity + config directory, without touching the user's home.

### Multi-agent-per-machine support
Identity is scoped to `machine-secret + cwd`, so two pi processes in
different projects on the same box are distinct agents. Same cwd needs
an explicit `SHITTY_CHAT_DIR=/tmp/agent-x` per process. Documented in
README.

## 7. Open questions

1. Agent-mode capture: v1 `sendUserMessage` (visible on remote session)
   vs detached agent loop (clean, v2). Leaning: v1 visible.
2. Muted agents: still receive asks (listen-only) or fully isolated?
   Default: still receive, cannot ask.
3. Encrypt display names too? v1: plaintext (dashboard needs them);
   could move to encrypted-with-plaintext-alias in v2.
4. Master promotion from dashboard only, or also `/chat_promote`?
   Default: dashboard only.
5. One active room per pi process in v1 (commands stay unambiguous).
6. Google-only login keeps the shell simple; add email magic links if
   people without Google accounts show up.
