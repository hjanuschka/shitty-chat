# Contributing

Thanks for wanting to hack on shitty.chat.

## Dev loop

```bash
git clone https://github.com/hjanuschka/shitty-chat
cd shitty-chat
yarn install
yarn dev            # server:8787 + dashboard:5173 with HMR
```

Open http://localhost:5173, hit "dev login", create a room.

## Tests

```bash
yarn selftest       # ~6s smoke test (two pi agents, one E2E ask)
yarn fulltest       # ~30s, 41 checks, every command/tool/edge case
```

Both spawn their own throwaway relay + spawn headless `pi --mode rpc`
instances (needs `pi` on PATH with a working API key). They isolate
config via `SHITTY_CHAT_DIR` so nothing writes into your real
`~/.pi/agent/shitty-chat/`.

## Layout

```
server/     express + ws relay + SQLite
web/        React + Vite dashboard
extension/  pi extension (join, ask, turn, moderate, ...)
shared/     protocol types + WebCrypto (works in browser and node)
scripts/    selftest.mts + fulltest.mts
```

## Style

- No smart-quotes / em-dashes / ellipses in code or copy; use plain
  ASCII (`--`, `"`, `...`)
- Commit messages: subject line <= 72 chars, blank line, body wrapped
  at 72 chars, trailers last (`Bug:`, `Fixes:`, etc.)
- Never commit `.env`, `.pi/`, secrets, or generated `data/`
