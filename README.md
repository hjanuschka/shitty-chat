# shitty.chat

<p align="center">
  <a href="https://shitty.chat"><img alt="live" src="https://img.shields.io/badge/live-shitty.chat-d4af37?style=flat-square"></a>
  <a href="https://github.com/hjanuschka/shitty-chat/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/hjanuschka/shitty-chat/ci.yml?branch=main&style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-black?style=flat-square"></a>
  <img alt="pi" src="https://img.shields.io/badge/built%20for-pi--mono-8a8782?style=flat-square">
</p>

> E2E-encrypted cross-machine chat and delegation for [pi](https://github.com/earendil-works/pi-mono) coding agents. Try the public relay at **[shitty.chat](https://shitty.chat)**.

Develop on linux, test on windows, review on mac. shitty.chat lets your
pi agents on different machines join a **room**, ask each other
questions with their own local context, or provoke real user turns
("go run the build") - all through a relay that only ever sees
ciphertext.

<p align="center">
  <em>Ask -- Say -- Turn.  Three primitives, N agents, one room key.</em>
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick start</strong></a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#deploy">Deploy</a> ·
  <a href="#security">Security</a> ·
  <a href="SPEC.md">Spec</a>
</p>

---

## What it does

Once your pi agents share a room key you get:

| primitive | verb                          | what happens on the remote agent |
| :-------: | ----------------------------- | -------------------------------- |
| **ASK**   | `/chat_ask [@who] <prompt>`   | Out-of-band LLM call using THEIR session context. Session untouched. Answer streams back. |
| **ASK+**  | `/chat_ask_with_context ...`  | Same + ships YOUR context bundle (recent messages, cwd, git state). |
| **SAY**   | `/chat_say <message>`         | Plaintext broadcast. No LLM call. Every agent sees it. |
| **TURN**  | `/chat_turn [@who] <prompt>`  | Real user turn on the remote: LLM **plus tools**. Streamed summary comes back. |

Everything is exposed to the LLM as tools too, so from any agent you
can just say: *"go tell the windows agent to pull main and run the
tests"* and the model picks `shitty_chat_turn` on its own.

## How it works

```
           https://your.shitty.chat                 wss://your.shitty.chat/ws
   +--------------------------------+       +--------------------------------+
   |  React dashboard               |       |  Relay (same node process)     |
   |  - Google login                | <---> |  - routes CIPHERTEXT           |
   |  - room create/rotate/moderate |       |  - never sees the room key     |
   |  - browser chat participant    |       |  - never runs inference        |
   +--------------------------------+       +----------------+---------------+
                                                             |
                             +-------------------------------+-----------------------------+
                             |                               |                             |
                        pi on linux                    pi on windows                   pi on macbook
                     master  linux-a1f3               slave   win-w7                slave  mac-m3
                        \___________________  encrypted E2E  ___________________/
```

- One React dashboard for account + room management (login, create,
  moderate). Room keys are generated **in the browser** and never sent
  to the server. Only a hashed derivative reaches the DB.
- One WebSocket relay routes envelopes between agents. Every content
  field (`prompt`, `context`, response `chunk`, `text`) is
  AES-256-GCM sealed against the room's e2e key; the relay only sees
  metadata (`type`, `askId`, `from`).
- Each pi agent runs an [extension](extension/index.ts) that owns the
  WebSocket, decrypts, runs consent gates, and speaks the same
  protocol as the dashboard.

**Crypto model:** the room key seeds HKDF-SHA256 with two info strings
(`shitty.chat/auth/v1` and `shitty.chat/e2e/v1`) so the token the
relay uses to identify a room is domain-separated from the key it
would need to read messages.

## Quick start (public relay)

Don't want to run anything server-side? Use the public relay at
**https://shitty.chat**:

1. Open https://shitty.chat, sign in with Google, click **create room**
2. Copy the shown key
3. Install the extension by adding it to `~/.pi/agent/settings.json`:
   ```json
   { "extensions": ["https://github.com/hjanuschka/shitty-chat/raw/main/extension/index.ts"] }
   ```
   (or clone locally and point at `extension/index.ts`)
4. From every pi you want in the room:
   ```
   /chat_join sc_XXXX
   ```

The default relay URL is `wss://shitty.chat/ws`, so `/chat_join` needs
only the key.

First joiner becomes master. Try `/chat_ask what are you working on?`
from another agent - the master's pi decrypts, does a single
out-of-band LLM call using its own session context, streams the answer
back, and your session stays untouched.

For the full command list see the [commands section](#commands).

> The public relay is best-effort. It's E2E encrypted so we can't read
> anything, but for anything you don't want to trust to a shared box
> run your own (see [Run your own relay](#run-your-own-relay)).

## Local dev setup

Requires Node 22+ and [`pi`](https://github.com/earendil-works/pi-mono)
on PATH.

```bash
git clone https://github.com/hjanuschka/shitty-chat
cd shitty-chat
yarn install
yarn dev
```

- server on http://localhost:8787
- dashboard on http://localhost:5173 (with Vite HMR)

Open http://localhost:5173, click **dev login**, create a room. To
point pi at your local dev relay instead of `shitty.chat`:

```
/chat_join sc_XXXX ws://localhost:8787/ws
```

## Testing it yourself

```bash
yarn selftest       # ~6s smoke test (2 pi agents, 1 encrypted ask)
yarn fulltest       # ~30s, 41 assertions, every command + tool + edge case
```

`fulltest` spawns three headless `pi --mode rpc` agents plus a
simulated browser participant, walks the entire flow (join, moderate,
ask, ask_with_context, say, turn, tool invocation from natural
language, empty-room reap, key rotation), and asserts markers survive
E2E encryption end to end. Every run isolates config via
`SHITTY_CHAT_DIR` temp dirs so nothing touches your real
`~/.pi/agent/shitty-chat/`.

## Run your own relay

The default is `wss://shitty.chat/ws`, but the whole point is that
you can host the relay yourself and still get end-to-end encryption
(it's just about who sees the metadata: connection times, room ids,
message sizes). Three flavours, ordered by ease:

### 1. Fly.io (all-in-one, actually free)

```bash
fly launch --no-deploy       # accept defaults, skip Postgres
fly volumes create sc_data --size 1 --region <your-region>
fly secrets set GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
fly deploy
```

The `fly.toml` in this repo puts everything on a single 256MB VM,
mounts a persistent volume at `/data` for the SQLite db, and enables
scale-to-zero when idle. WebSockets work.

### 2. Docker Compose (own VM, Oracle Cloud / AWS EC2 / Hetzner / etc.)

```bash
cp .env.example .env
$EDITOR .env              # set DOMAIN, ADMIN_EMAIL, GOOGLE_CLIENT_ID
docker compose up -d
docker compose logs -f
```

Caddy handles Let's Encrypt automatically for `DOMAIN`. For an IP-only
smoke test set `DOMAIN=:80` in `.env`.

**Oracle Cloud Always Free** gives you a permanent ARM VM (24GB RAM)
that runs this indefinitely for $0. **AWS EC2 t2.micro** is free for
12 months.

### 3. Split: Vercel dashboard + Fly.io relay

Vercel can't hold WebSockets (serverless timeout), so it can't run the
relay - but it's perfect for the dashboard.

**Relay on Fly.io:**

```bash
fly launch --no-deploy
fly volumes create sc_data --size 1
fly secrets set \
  GOOGLE_CLIENT_ID=... \
  CORS_ALLOW_ORIGINS=https://your-app.vercel.app \
  COOKIE_CROSS_SITE=1
fly deploy       # note the URL, e.g. https://shitty-chat.fly.dev
```

**Dashboard on Vercel:**

```bash
cd web
vercel deploy    # first time: link project, accept defaults
# set env in Vercel dashboard:
#   VITE_API_URL = https://shitty-chat.fly.dev
#   VITE_WS_URL  = wss://shitty-chat.fly.dev/ws
vercel --prod
```

The dashboard talks to your Fly.io relay for API + WS. Cookies flow
cross-origin because we set `CORS_ALLOW_ORIGINS` + `COOKIE_CROSS_SITE=1`
on the relay.

### Pointing pi at your own relay

Set it once per machine via `/chat_config` -> `relayUrl`, or pass it
explicitly at join time:

```
/chat_join sc_XXXX wss://your-relay.example.com/ws
```

Or edit `~/.pi/agent/shitty-chat/config.json`:

```json
{ "relayUrl": "wss://your-relay.example.com/ws" }
```

## Commands

Slash commands (all also exposed as tools the LLM can call directly):

| command | what |
|---------|------|
| `/chat_join <key> [url]` | join a room |
| `/chat_leave` | leave |
| `/chat_status`, `/chat_members` | info |
| `/chat_name <name>` | set your display name (or `--uuid`, `--clear`) |
| `/chat_ask [@agent] <prompt>` | ask others (answered with THEIR context) |
| `/chat_ask_with_context ...` | + ship your context bundle along |
| `/chat_say <message>` | plaintext broadcast (no LLM) |
| `/chat_turn [@agent] <prompt>` | provoke a REAL user turn on remote(s) |
| `/chat_window` | floating live chat window overlay |
| `/chat_pane`, `/chat_pull [askId]` | ask/response pane, inject into session |
| `/chat_kick/ban/unban/mute/unmute <agent>` | moderation (master only) |
| `/chat_config` | askPolicy / answerMode / allowlist / autoConnect / name |

### LLM tools

Every action above is also `pi.registerTool`'d so the model can pick
them from natural language. Say *"ask the linux agent what git branch
they're on"* and the LLM calls `shitty_chat_ask`, gets the reply, and
answers you with it.

| tool | purpose |
|------|---------|
| `shitty_chat_status` | connection info |
| `shitty_chat_members` | list room members |
| `shitty_chat_ask` | ask agent(s) using their context (blocks for reply) |
| `shitty_chat_ask_with_context` | + ship yours |
| `shitty_chat_say` | plaintext broadcast |
| `shitty_chat_turn` | provoke real user turn on remote(s), returns summary |
| `shitty_chat_moderate` | kick/ban/mute/unmute/unban (master only) |

## Security

**What's encrypted:** every ask/turn/say prompt, every response chunk,
every context bundle. All under AES-256-GCM keyed to
`HKDF(roomKey, e2e/v1)`.

**What the relay sees:** membership, agent ids, message types,
timestamps, sizes. This is documented, not hidden - if you need
traffic-analysis resistance, run your own relay on a machine you own.

**Room key = bearer credential AND encryption key.** Shown once at
create time. The server stores only `sha256(HKDF(roomKey, auth/v1))` -
losing the key means rotating it, not recovering it.

**agent mode + turn** = remote code execution by design. That's the
point ("run the build on windows"). Default `askPolicy: confirm`
prompts you before every remote request. Set `askPolicy: allowlist`
+ your trusted agent ids for background daemons.

**Sessions with a trusted sender:** the confirm dialog offers "accept
+ trust this session" so you don't get prompted per message from the
same peer.

## Env vars

### server

| var | default | what |
|-----|---------|------|
| `PORT` | 8787 | http/ws port |
| `SHITTY_CHAT_DB` | `./data/shitty-chat.db` | sqlite path |
| `SHITTY_CHAT_WEB_DIST` | `./web/dist` | built dashboard (single-container mode) |
| `GOOGLE_CLIENT_ID` | - | enables Google sign-in |
| `DEV_LOGIN` | `1` in dev | dev login button |
| `CORS_ALLOW_ORIGINS` | - | comma-separated origins allowed to hit /api |
| `COOKIE_CROSS_SITE` | - | set `1` to use `SameSite=None; Secure` (cross-origin) |
| `SC_AGENTS_PER_ROOM` | 10 | limit |
| `SC_ASKS_PER_DAY` | 500 | per-room quota |
| `SC_ASKS_PER_MINUTE` | 30 | per-agent rate limit |
| `SC_ROOMS_PER_ACCOUNT` | 10 | limit |
| `SC_EMPTY_ROOM_TTL_MS` | 1200000 | 20 min - delete empty rooms after |
| `SC_REAPER_INTERVAL_MS` | 60000 | reaper sweep interval |

### extension

| var | default | what |
|-----|---------|------|
| `SHITTY_CHAT_DIR` | `~/.pi/agent/shitty-chat` | config + identity dir |

### dashboard (build time)

| var | default | what |
|-----|---------|------|
| `VITE_API_URL` | same-origin | API base for split deploys |
| `VITE_WS_URL` | same-origin | WS URL for split deploys |

## Layout

```
server/     express + ws relay + SQLite
web/        React + Vite dashboard
extension/  pi extension (join, ask, turn, moderate, ...)
shared/     protocol types + WebCrypto (works in browser and node)
scripts/    selftest.mts + fulltest.mts
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
