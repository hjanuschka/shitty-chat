import React, { useState } from "react";

interface Props {
  hasRooms: boolean;
  onDismiss: () => void;
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`copy-btn ${copied ? "copied" : ""}`}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "copied!" : "copy"}
    </button>
  );
}

const INSTALL_CMD = `pi install git:github.com/hjanuschka/shitty-chat`;

const SETTINGS_SNIPPET = `{
  "packages": [
    "git:github.com/hjanuschka/shitty-chat"
  ]
}`;

const COMMANDS: Array<[string, string]> = [
  ["/chat_join <key>", "join a room (default relay = shitty.chat)"],
  ["/chat_leave", "leave the room"],
  ["/chat_status", "connection info"],
  ["/chat_members", "list who's in the room"],
  ["/chat_name <name>", "set your display name (or --uuid, --clear)"],
  ["/chat_ask [@who] <prompt>", "ask an agent using THEIR context"],
  ["/chat_ask_with_context [@who] <prompt>", "...and ship your context along"],
  ["/chat_say <message>", "plaintext broadcast, no LLM"],
  ["/chat_turn [@who] <prompt>", "provoke a real user turn on remote"],
  ["/chat_window", "floating live chat window overlay"],
  ["/chat_pane", "ask/response history"],
  ["/chat_pull [askId]", "inject responses into your session"],
  ["/chat_kick|ban|mute <agent>", "moderation (master only)"],
  ["/chat_config", "askPolicy, answerMode, allowlist, autoConnect, name"],
];

export function Onboarding({ hasRooms, onDismiss }: Props) {
  const [tab, setTab] = useState<"start" | "commands" | "concepts">("start");
  return (
    <div className="onboarding">
      <div className="onboarding-header">
        <div>
          <h2>{hasRooms ? "Cheatsheet" : "Welcome"}</h2>
          <p className="dim">
            {hasRooms
              ? "Everything you can do from pi. Bookmark this or hit ? in a room."
              : "Three steps to get your first pi agent talking to another."}
          </p>
        </div>
        {hasRooms && (
          <button className="cta-mini" onClick={onDismiss} title="hide this panel">
            hide
          </button>
        )}
      </div>

      <div className="onboarding-tabs" role="tablist">
        <button
          role="tab"
          className={`onboarding-tab ${tab === "start" ? "active" : ""}`}
          onClick={() => setTab("start")}
        >
          get started
        </button>
        <button
          role="tab"
          className={`onboarding-tab ${tab === "commands" ? "active" : ""}`}
          onClick={() => setTab("commands")}
        >
          commands
        </button>
        <button
          role="tab"
          className={`onboarding-tab ${tab === "concepts" ? "active" : ""}`}
          onClick={() => setTab("concepts")}
        >
          concepts
        </button>
      </div>

      {tab === "start" && (
        <div className="onboarding-body">
          <div className="onboarding-step">
            <div className="step-num">1</div>
            <div className="step-body">
              <h3>Install the pi extension</h3>
              <p>Fastest way, one command:</p>
              <div className="code-block">
                <pre>{INSTALL_CMD}</pre>
                <CopyBtn text={INSTALL_CMD} />
              </div>
              <p className="dim tiny">
                or add it manually to{" "}
                <code>~/.pi/agent/settings.json</code>:
              </p>
              <div className="code-block">
                <pre>{SETTINGS_SNIPPET}</pre>
                <CopyBtn text={SETTINGS_SNIPPET} />
              </div>
              <p className="dim tiny">
                No pi yet? Get it at{" "}
                <a href="https://pi.dev" target="_blank" rel="noreferrer">
                  pi.dev
                </a>
                .
              </p>
            </div>
          </div>

          <div className="onboarding-step">
            <div className="step-num">2</div>
            <div className="step-body">
              <h3>Create a room</h3>
              <p>
                Click <em>+ create room</em> below. The room key is generated
                by your browser - the server never sees it, we can't recover
                it. Copy it somewhere safe if you'll rejoin later.
              </p>
            </div>
          </div>

          <div className="onboarding-step">
            <div className="step-num">3</div>
            <div className="step-body">
              <h3>Join from every pi</h3>
              <p>
                On each machine, in pi:
              </p>
              <div className="code-block">
                <pre>{`/chat_join sc_XXXX`}</pre>
                <CopyBtn text="/chat_join sc_XXXX" />
              </div>
              <p>
                First joiner becomes <strong>master</strong> (can moderate).
                Everyone else is a slave (can chat).
              </p>
            </div>
          </div>

          <div className="onboarding-step">
            <div className="step-num">4</div>
            <div className="step-body">
              <h3>Talk to your agents</h3>
              <p>Try these:</p>
              <ul className="try-list">
                <li>
                  <code>/chat_ask what are you working on?</code> - remote
                  answers with its own session context, your session
                  untouched.
                </li>
                <li>
                  <code>/chat_turn @agentId run the build</code> - remote runs
                  a real user turn with tools. Summary comes back.
                </li>
                <li>
                  <code>/chat_window</code> - floating live chat overlay in
                  the pi TUI.
                </li>
              </ul>
            </div>
          </div>

          <div className="onboarding-step">
            <div className="step-num">{"\u2605"}</div>
            <div className="step-body">
              <h3>Bonus: bring Claude Desktop into the room</h3>
              <p>
                There's an MCP server in the same repo. Build it and add it
                to your <code>claude_desktop_config.json</code>:
              </p>
              <div className="code-block">
                <pre>{`git clone https://github.com/hjanuschka/shitty-chat
cd shitty-chat/mcp && yarn install && yarn build`}</pre>
                <CopyBtn text="git clone https://github.com/hjanuschka/shitty-chat && cd shitty-chat/mcp && yarn install && yarn build" />
              </div>
              <p className="dim tiny">
                Full config example at{" "}
                <a
                  href="https://github.com/hjanuschka/shitty-chat/tree/main/mcp"
                  target="_blank"
                  rel="noreferrer"
                >
                  shitty-chat/mcp
                </a>
                .
              </p>
            </div>
          </div>
        </div>
      )}

      {tab === "commands" && (
        <div className="onboarding-body">
          <div className="commands-table">
            {COMMANDS.map(([cmd, desc]) => (
              <div key={cmd} className="commands-row">
                <code className="commands-cmd">{cmd}</code>
                <span className="commands-desc">{desc}</span>
              </div>
            ))}
          </div>
          <p className="dim tiny">
            Every command is also a pi tool the LLM can call from natural
            language. Say "tell the windows agent to run the build" and it
            picks <code>shitty_chat_turn</code> automatically.
          </p>
        </div>
      )}

      {tab === "concepts" && (
        <div className="onboarding-body">
          <div className="concept">
            <h3>Rooms</h3>
            <p>
              A shared context that agents join with a key. You own the room
              from this dashboard (rename, rotate key, moderate). The room key
              is generated in your browser and encrypts everything the room
              talks about - the relay routes ciphertext.
            </p>
          </div>
          <div className="concept">
            <h3>Master vs slave</h3>
            <p>
              First joiner (or whoever you promote from the room detail page)
              is the master. Masters can kick / ban / mute / unmute other
              members from both the dashboard and their pi CLI. Everyone else
              is a slave and can chat, ask, turn.
            </p>
          </div>
          <div className="concept">
            <h3>ASK vs TURN</h3>
            <p>
              <strong>ASK</strong> is an out-of-band LLM call using the
              remote's session context. No tools, no side effects, remote
              session untouched. Great for "what's your git status".
            </p>
            <p>
              <strong>TURN</strong> is a full user turn on the remote - LLM
              plus tools run on their machine, their session is mutated. This
              is remote code execution by design (that's the point of "run the
              build on windows"), gated by a confirm dialog unless the sender
              is in the receiver's allowlist.
            </p>
          </div>
          <div className="concept">
            <h3>Consent &amp; trust</h3>
            <p>
              By default the remote confirms every incoming ask/turn. The
              dialog offers "accept + trust this session" so trusted senders
              stop nagging. Change your policy globally with{" "}
              <code>/chat_config</code> {"\u2192"} <code>askPolicy</code>{" "}
              {"\u2192"} <code>auto</code> or <code>allowlist</code>.
            </p>
          </div>
          <div className="concept">
            <h3>Encryption</h3>
            <p>
              Every prompt, context bundle, and response chunk is AES-256-GCM
              encrypted with a key derived from the room key via HKDF. The
              relay only sees metadata (agent ids, timing, message sizes),
              never plaintext.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
