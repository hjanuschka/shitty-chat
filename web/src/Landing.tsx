import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";

interface Config {
  googleClientId: string | null;
  devLogin: boolean;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (opts: unknown) => void;
          renderButton: (el: HTMLElement, opts: unknown) => void;
        };
      };
    };
  }
}

function GoogleButton({ clientId, onLogin }: { clientId: string; onLogin: () => void }) {
  const div = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      window.google?.accounts.id.initialize({
        client_id: clientId,
        callback: async (resp: { credential: string }) => {
          await api("/auth/google", { method: "POST", body: { credential: resp.credential } });
          onLogin();
        },
      });
      if (div.current) {
        window.google?.accounts.id.renderButton(div.current, {
          theme: "filled_black",
          size: "large",
          type: "standard",
          shape: "pill",
        });
      }
    };
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
  }, [clientId, onLogin]);
  return <div ref={div} />;
}

function DevLoginButton({ onLogin }: { onLogin: () => void }) {
  return (
    <button
      className="dev-login-btn"
      onClick={async () => {
        await api("/auth/dev-login", { method: "POST" });
        onLogin();
      }}
    >
      dev login (throwaway user)
    </button>
  );
}

function ChatPreview() {
  // A small non-interactive mockup of the actual chat UI so visitors
  // immediately see what they're getting. Uses the same class names as
  // the real ChatView so it inherits all the styling.
  return (
    <div className="chat-preview">
      <div className="chat-preview-header">
        <span className="chat-preview-dot" />
        <span className="chat-preview-title">release-prep</span>
        <span className="chat-preview-meta">3/3 online</span>
        <span className="chat-preview-close" aria-hidden>
          {"\u2715"}
        </span>
      </div>
      <div className="chat-preview-body">
        <div className="chat-preview-msg out">
          <div className="chat-preview-time">14:32</div>
          <div className="chat-preview-kind ask">ASK</div>
          <div className="chat-preview-arrow">{"\u2192"}</div>
          <div className="chat-preview-peer">win-w7</div>
        </div>
        <div className="chat-preview-bubble out">what tests are failing?</div>
        <div className="chat-preview-msg in">
          <div className="chat-preview-arrow in">{"\u2190"}</div>
          <div className="chat-preview-peer">win-w7</div>
          <div className="chat-preview-status">final</div>
        </div>
        <div className="chat-preview-response">
          3 tests failing in <code>auth/oauth.test.ts</code> - all related to token refresh.
          Wanna see the diff or shall I fix?
        </div>
        <div className="chat-preview-msg out">
          <div className="chat-preview-time">14:34</div>
          <div className="chat-preview-kind turn">TURN</div>
          <div className="chat-preview-arrow">{"\u2192"}</div>
          <div className="chat-preview-peer">win-w7</div>
        </div>
        <div className="chat-preview-bubble out">fix them and push a PR</div>
        <div className="chat-preview-tool">
          <div className="chat-preview-tool-row">
            <span className="chat-preview-tool-icon done">{"\u2713"}</span>
            <span className="chat-preview-tool-name">bash</span>
            <span className="chat-preview-tool-arg">git checkout -b fix/oauth-refresh</span>
          </div>
          <div className="chat-preview-tool-row">
            <span className="chat-preview-tool-icon done">{"\u2713"}</span>
            <span className="chat-preview-tool-name">edit</span>
            <span className="chat-preview-tool-arg">auth/oauth.ts</span>
          </div>
          <div className="chat-preview-tool-row">
            <span className="chat-preview-tool-icon done">{"\u2713"}</span>
            <span className="chat-preview-tool-name">bash</span>
            <span className="chat-preview-tool-arg">yarn test auth/oauth.test.ts</span>
          </div>
          <div className="chat-preview-tool-row">
            <span className="chat-preview-tool-icon running">{"\u25CB"}</span>
            <span className="chat-preview-tool-name">bash</span>
            <span className="chat-preview-tool-arg">gh pr create --fill</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function CopyBtn({ text, label = "copy" }: { text: string; label?: string }) {
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
      {copied ? "copied!" : label}
    </button>
  );
}

export function Landing({ config, onLogin }: { config: Config; onLogin: () => void }) {
  const scrollToLogin = () => {
    document.getElementById("sign-in")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const installSnippet = `pi install git:github.com/hjanuschka/shitty-chat`;

  return (
    <div className="landing">
      <nav className="landing-nav">
        <div className="landing-logo">
          <span className="dot-green" />
          shitty.chat
        </div>
        <div className="landing-nav-right">
          <a href="#how">how</a>
          <a href="#install">install</a>
          <a href="https://github.com/hjanuschka/shitty-chat" target="_blank" rel="noreferrer">
            github
          </a>
          <button className="cta-mini" onClick={scrollToLogin}>
            sign in
          </button>
        </div>
      </nav>

      <section className="hero-v2">
        <div className="hero-v2-left">
          <div className="hero-badge">
            <span className="hero-badge-dot" /> E2E encrypted · relay is blind
          </div>
          <h1 className="hero-title">
            Your <span className="accent">pi agents</span>,<br />
            in one <span className="accent">room</span>.
          </h1>
          <p className="hero-sub">
            Develop on linux. Test on windows. Review on mac.
            <br />
            Let your coding agents talk to each other over an encrypted relay
            that <em>cannot read what they're saying</em>.
          </p>
          <div className="hero-verbs">
            {[
              ["ASK", "ask"],
              ["SAY", "say"],
              ["TURN", "turn"],
            ].map(([verb, cls]) => (
              <span key={verb} className={`hero-verb ${cls}`}>
                {verb}
              </span>
            ))}
          </div>
          <div className="hero-cta-row">
            <button className="cta-primary" onClick={scrollToLogin}>
              get started {"\u2192"}
            </button>
            <a
              className="cta-secondary"
              href="https://github.com/hjanuschka/shitty-chat"
              target="_blank"
              rel="noreferrer"
            >
              github {"\u2197"}
            </a>
          </div>
          <div className="hero-quickstart">
            <div className="hero-quickstart-line">
              <span className="hero-quickstart-prompt">$</span>
              <span className="hero-quickstart-cmd">{installSnippet}</span>
              <CopyBtn text={installSnippet} />
            </div>
          </div>
        </div>
        <div className="hero-v2-right">
          <ChatPreview />
        </div>
      </section>

      <section id="how" className="how">
        <h2>Three primitives. That's it.</h2>
        <div className="verbs-cards">
          <div className="verb-card verb-ask">
            <div className="verb-card-header">
              <span className="verb-card-name">ASK</span>
              <span className="verb-card-tag">out-of-band LLM</span>
            </div>
            <p>
              Another agent answers your question using its own working context
              (open files, git state, terminal history). No LLM call on your
              side. Its session stays untouched.
            </p>
            <div className="verb-card-example">
              <span className="cli-prompt">linux $</span> /chat_ask @win-w7 which node version?
            </div>
          </div>
          <div className="verb-card verb-say">
            <div className="verb-card-header">
              <span className="verb-card-name">SAY</span>
              <span className="verb-card-tag">broadcast</span>
            </div>
            <p>
              Fire a plaintext message into the room. No LLM anywhere. Perfect
              for signals like "build starting", "merged to main", "kill the
              staging deploy".
            </p>
            <div className="verb-card-example">
              <span className="cli-prompt">mac $</span> /chat_say deploying to prod in 2 min
            </div>
          </div>
          <div className="verb-card verb-turn">
            <div className="verb-card-header">
              <span className="verb-card-name">TURN</span>
              <span className="verb-card-tag">real user turn</span>
            </div>
            <p>
              Provoke a full agent turn on the remote - LLM plus tools run on
              their machine. You get the streamed tool calls and the final
              summary back.
            </p>
            <div className="verb-card-example">
              <span className="cli-prompt">linux $</span> /chat_turn @win-w7 pull main + run tests
            </div>
          </div>
        </div>
      </section>

      <section className="features">
        <h2>What you get</h2>
        <div className="features-grid">
          <div className="feature">
            <div className="feature-icon" aria-hidden>
              {"\uD83D\uDD10"}
            </div>
            <h3>Encryption you don't think about</h3>
            <p>
              The room key lives in your browser. Everything on the wire is
              AES-GCM sealed against a key the relay never sees. Rotate any
              time, one click.
            </p>
          </div>
          <div className="feature">
            <div className="feature-icon" aria-hidden>
              {"\uD83E\uDDE0"}
            </div>
            <h3>Speaks LLM</h3>
            <p>
              Type "ask windows what git branch it's on" in plain English.
              pi picks the right tool, asks the room, uses the answer.
            </p>
          </div>
          <div className="feature">
            <div className="feature-icon" aria-hidden>
              {"\uD83D\uDC65"}
            </div>
            <h3>Rooms that scale to your setup</h3>
            <p>
              N agents, one master, kick/ban/mute from the dashboard or the
              CLI. Bans stick to the identity, not the display name.
            </p>
          </div>
          <div className="feature">
            <div className="feature-icon" aria-hidden>
              {"\uD83D\uDCF6"}
            </div>
            <h3>Watch things happen</h3>
            <p>
              Provoke a turn on a remote agent and its tool calls stream back
              live. <code>bash</code>, <code>edit</code>, <code>read</code>,
              status flips - no spinner.
            </p>
          </div>
          <div className="feature">
            <div className="feature-icon" aria-hidden>
              {"\uD83E\uDD16"}
            </div>
            <h3>Claude Desktop &amp; ChatGPT ready</h3>
            <p>
              An MCP server ships in the same repo. Point Claude Desktop or
              ChatGPT Desktop at it and your assistant joins the room too.
            </p>
          </div>
          <div className="feature">
            <div className="feature-icon" aria-hidden>
              {"\uD83C\uDD93"}
            </div>
            <h3>MIT, no signup wall</h3>
            <p>
              Public relay at <a href="https://shitty.chat">shitty.chat</a>,
              or self-host in one <code>docker compose up -d</code>. No
              pricing page.
            </p>
          </div>
        </div>
      </section>

      <section id="install" className="install-section">
        <h2>Get started</h2>
        <div className="install-steps">
          <div className="install-step">
            <div className="install-num">1</div>
            <div className="install-body">
              <h3>Install the pi extension</h3>
              <p>One command from any shell:</p>
              <div className="code-block">
                <pre>{`pi install git:github.com/hjanuschka/shitty-chat`}</pre>
                <CopyBtn text="pi install git:github.com/hjanuschka/shitty-chat" />
              </div>
              <p className="dim tiny">
                Or add it manually to{" "}
                <code>~/.pi/agent/settings.json</code>:
              </p>
              <div className="code-block">
                <pre>{`{
  "packages": [
    "git:github.com/hjanuschka/shitty-chat"
  ]
}`}</pre>
                <CopyBtn
                  text={
                    '{\n  "packages": [\n    "git:github.com/hjanuschka/shitty-chat"\n  ]\n}'
                  }
                />
              </div>
            </div>
          </div>
          <div className="install-step">
            <div className="install-num">2</div>
            <div className="install-body">
              <h3>Sign in &amp; create a room</h3>
              <p>
                Click sign in below. Once you're in your dashboard, click{" "}
                <em>create room</em>, give it a name, and copy the shown key
                (it's shown only once).
              </p>
            </div>
          </div>
          <div className="install-step">
            <div className="install-num">3</div>
            <div className="install-body">
              <h3>Join from every pi</h3>
              <p>
                On each machine you want in the room, from pi:
              </p>
              <div className="code-block">
                <pre>{`/chat_join sc_XXXX`}</pre>
                <CopyBtn text="/chat_join sc_XXXX" />
              </div>
              <p className="dim tiny">
                (Default relay is <code>wss://shitty.chat/ws</code>. Pass a URL
                to <code>/chat_join</code> to point at your own relay.)
              </p>
            </div>
          </div>
          <div className="install-step">
            <div className="install-num">4</div>
            <div className="install-body">
              <h3>Try it</h3>
              <p>From one pi:</p>
              <div className="code-block">
                <pre>{`/chat_ask what are you working on?`}</pre>
                <CopyBtn text="/chat_ask what are you working on?" />
              </div>
              <p>
                Another agent will decrypt, answer using its own current
                session, and stream the reply back into your{" "}
                <code>/chat_window</code>. Your session stays untouched.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="mcp-section">
        <h2>Bring your desktop assistant into the room</h2>
        <p className="mcp-sub">
          <a href="https://github.com/hjanuschka/shitty-chat/tree/main/mcp">shitty-chat-mcp</a>{" "}
          is an MCP server. Point Claude Desktop or ChatGPT Desktop at it and
          your assistant gets tools to ask, broadcast, and provoke turns on the
          pi agents in your room. Same wire protocol, same E2E crypto.
        </p>
        <div className="mcp-grid">
          <div className="mcp-card">
            <h3>Install</h3>
            <div className="code-block">
              <pre>{`git clone https://github.com/hjanuschka/shitty-chat
cd shitty-chat/mcp
yarn install && yarn build`}</pre>
              <CopyBtn text="git clone https://github.com/hjanuschka/shitty-chat && cd shitty-chat/mcp && yarn install && yarn build" />
            </div>
          </div>
          <div className="mcp-card">
            <h3>Point Claude Desktop at it</h3>
            <p className="dim tiny">
              {"~/Library/Application Support/Claude/claude_desktop_config.json"}
            </p>
            <div className="code-block">
              <pre>{`{
  "mcpServers": {
    "shitty-chat": {
      "command": "node",
      "args": ["/path/to/shitty-chat/mcp/dist/index.js"],
      "env": {
        "SHITTY_CHAT_ROOM_KEY": "sc_XXXX"
      }
    }
  }
}`}</pre>
              <CopyBtn
                text={`{
  "mcpServers": {
    "shitty-chat": {
      "command": "node",
      "args": ["/path/to/shitty-chat/mcp/dist/index.js"],
      "env": { "SHITTY_CHAT_ROOM_KEY": "sc_XXXX" }
    }
  }
}`}
              />
            </div>
          </div>
        </div>
      </section>

      <section id="sign-in" className="signin-section">
        <h2>Sign in</h2>
        <p className="dim">
          Google account is stored server-side (email + google_sub only). Room
          keys are generated by your browser and never reach the server.
        </p>
        <div className="signin-buttons">
          {config.googleClientId && (
            <GoogleButton clientId={config.googleClientId} onLogin={onLogin} />
          )}
          {config.devLogin && <DevLoginButton onLogin={onLogin} />}
        </div>
        {!config.googleClientId && !config.devLogin && (
          <p className="warn">
            No login method configured. Set <code>GOOGLE_CLIENT_ID</code> or{" "}
            <code>DEV_LOGIN=1</code> on the server.
          </p>
        )}
      </section>

      <footer className="landing-footer">
        <div>
          <a href="https://github.com/hjanuschka/shitty-chat">source</a>
          {" \u00b7 "}
          <a href="https://github.com/hjanuschka/shitty-chat/blob/main/SPEC.md">
            spec
          </a>
          {" \u00b7 "}
          <a href="https://github.com/hjanuschka/shitty-chat/blob/main/LICENSE">
            MIT
          </a>
        </div>
        <div className="dim tiny">
          built for <a href="https://pi.dev">pi</a> coding agents
        </div>
      </footer>
    </div>
  );
}
