import React, { useCallback, useEffect, useState } from "react";
import { api, wsUrl } from "./api";
import { deriveKeys, generateRoomKey, sha256Hex } from "../../shared/crypto";
import { ChatView } from "./ChatView";
import { Landing } from "./Landing";

interface Config {
  googleClientId: string | null;
  devLogin: boolean;
}

interface Me {
  email: string;
  loginToken: string;
}

interface RoomSummary {
  id: string;
  name: string;
  createdAt: number;
  agents: number;
}

interface Agent {
  agentId: string;
  name: string;
  platform: string;
  role: "master" | "slave";
  state: "active" | "muted" | "banned";
  connected: boolean;
  lastSeen: number;
}

interface UsageRow {
  day: string;
  asks: number;
  bytes: number;
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



async function makeRoomKeyMaterial() {
  const roomKey = generateRoomKey();
  const { authKeyHex } = await deriveKeys(roomKey);
  const authTokenHash = await sha256Hex(authKeyHex);
  return { roomKey, authTokenHash };
}

function KeyReveal({
  roomKey,
  onClose,
  onJoinBrowser,
}: {
  roomKey: string;
  onClose: () => void;
  onJoinBrowser?: (key: string) => void;
}) {
  const snippet = `/chat_join ${roomKey} ${wsUrl()}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Room key (shown once)</h3>
        <p className="warn">
          This key is generated in your browser and the server never sees it. We cannot recover
          it. If you lose it, rotate the key.
        </p>
        <code className="key">{roomKey}</code>
        <p>Paste this into pi on every machine that should join:</p>
        <code className="key">{snippet}</code>
        <div className="row">
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(snippet);
              setCopied(true);
            }}
          >
            {copied ? "copied!" : "copy /chat_join snippet"}
          </button>
          {onJoinBrowser && (
            <button onClick={() => onJoinBrowser(roomKey)}>join in browser</button>
          )}
          <button onClick={onClose}>done</button>
        </div>
      </div>
    </div>
  );
}

function Login({ config, onLogin }: { config: Config; onLogin: () => void }) {
  const googleDiv = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!config.googleClientId) return;
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      window.google?.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: async (resp: { credential: string }) => {
          await api("/auth/google", { method: "POST", body: { credential: resp.credential } });
          onLogin();
        },
      });
      if (googleDiv.current) {
        window.google?.accounts.id.renderButton(googleDiv.current, { theme: "filled_black" });
      }
    };
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
  }, [config.googleClientId, onLogin]);

  return (
    <div className="center">
      <h1>shitty.chat</h1>
      <p className="tagline">E2E encrypted cross-machine chat for pi agents</p>
      <p className="tagline dim">
        The relay routes ciphertext only. Room keys never leave your machines.
      </p>
      <div ref={googleDiv} />
      {config.devLogin && (
        <button
          onClick={async () => {
            await api("/auth/dev-login", { method: "POST" });
            onLogin();
          }}
        >
          dev login
        </button>
      )}
    </div>
  );
}

function RoomDetail({
  room,
  onBack,
  onJoinBrowser,
}: {
  room: RoomSummary;
  onBack: () => void;
  onJoinBrowser: () => void;
}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAgents(await api<Agent[]>(`/product/rooms/${room.id}/agents`));
      setUsage(await api<UsageRow[]>(`/product/rooms/${room.id}/usage`));
    } catch (e) {
      setError(String(e));
    }
  }, [room.id]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (agentId: string, action: string) => {
    await api(`/product/rooms/${room.id}/agents/${agentId}/${action}`, { method: "POST" });
    refresh();
  };

  const rotate = async () => {
    if (!confirm("Rotate key? All agents get disconnected and the old key stops working.")) return;
    const { roomKey, authTokenHash } = await makeRoomKeyMaterial();
    await api(`/product/rooms/${room.id}/rotate-key`, { method: "POST", body: { authTokenHash } });
    setNewKey(roomKey);
  };

  return (
    <div>
      <button onClick={onBack}>&larr; rooms</button>
      <h2>
        {room.name} <span className="dim">({room.id})</span>
      </h2>
      {error && <p className="warn">{error}</p>}
      <div className="row">
        <button onClick={rotate}>rotate key</button>
        <button onClick={onJoinBrowser}>join in browser (paste key)</button>
      </div>
      <h3>Agents</h3>
      <table>
        <thead>
          <tr>
            <th>agent</th>
            <th>name</th>
            <th>platform</th>
            <th>role</th>
            <th>state</th>
            <th>online</th>
            <th>actions</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.agentId} className={a.connected ? "" : "dim"}>
              <td>
                <code>{a.agentId}</code>
              </td>
              <td>{a.name}</td>
              <td>{a.platform}</td>
              <td>{a.role}</td>
              <td>{a.state}</td>
              <td>{a.connected ? "yes" : "no"}</td>
              <td className="actions">
                {a.connected && <button onClick={() => act(a.agentId, "kick")}>kick</button>}
                {a.state !== "banned" ? (
                  <button onClick={() => act(a.agentId, "ban")}>ban</button>
                ) : (
                  <button onClick={() => act(a.agentId, "unban")}>unban</button>
                )}
                {a.state === "muted" ? (
                  <button onClick={() => act(a.agentId, "unmute")}>unmute</button>
                ) : (
                  a.state === "active" && <button onClick={() => act(a.agentId, "mute")}>mute</button>
                )}
                {a.role !== "master" && (
                  <button onClick={() => act(a.agentId, "promote")}>promote</button>
                )}
              </td>
            </tr>
          ))}
          {agents.length === 0 && (
            <tr>
              <td colSpan={7} className="dim">
                no agents yet - join with the room key from pi
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <h3>Usage (asks/day)</h3>
      <table>
        <tbody>
          {usage.map((u) => (
            <tr key={u.day}>
              <td>{u.day}</td>
              <td>{u.asks} asks</td>
              <td>{(u.bytes / 1024).toFixed(1)} KB relayed</td>
            </tr>
          ))}
          {usage.length === 0 && (
            <tr>
              <td className="dim">no usage yet</td>
            </tr>
          )}
        </tbody>
      </table>
      {newKey && <KeyReveal roomKey={newKey} onClose={() => setNewKey(null)} />}
    </div>
  );
}

function Rooms({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selected, setSelected] = useState<RoomSummary | null>(null);
  const [chatOpen, setChatOpen] = useState<string | null>(null); // holds prefilled key when set
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRooms(await api<RoomSummary[]>("/product/rooms"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const create = async () => {
    const name = prompt("Room name:");
    if (!name) return;
    try {
      const { roomKey, authTokenHash } = await makeRoomKeyMaterial();
      await api("/product/rooms", { method: "POST", body: { name, authTokenHash } });
      setNewKey(roomKey);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (room: RoomSummary) => {
    if (!confirm(`Delete room "${room.name}"?`)) return;
    await api(`/product/rooms/${room.id}`, { method: "DELETE" });
    refresh();
  };

  if (chatOpen !== null)
    return <ChatView email={me.email} initialKey={chatOpen} onExit={() => setChatOpen(null)} />;
  if (selected)
    return (
      <RoomDetail
        room={selected}
        onBack={() => setSelected(null)}
        onJoinBrowser={() => setChatOpen("")}
      />
    );

  return (
    <div>
      <div className="header">
        <h1>shitty.chat</h1>
        <div>
          <span className="dim">{me.email}</span>{" "}
          <button
            onClick={async () => {
              await api("/auth/logout", { method: "POST" });
              onLogout();
            }}
          >
            logout
          </button>
        </div>
      </div>
      {error && <p className="warn">{error}</p>}
      <div className="row">
        <button onClick={create}>+ create room</button>
        <button onClick={() => setChatOpen("")}>chat: join with key</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>room</th>
            <th>id</th>
            <th>agents online</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rooms.map((room) => (
            <tr key={room.id}>
              <td>
                <a href="#" onClick={(e) => (e.preventDefault(), setSelected(room))}>
                  {room.name}
                </a>
              </td>
              <td>
                <code>{room.id}</code>
              </td>
              <td>{room.agents}</td>
              <td>
                <button onClick={() => remove(room)}>delete</button>
              </td>
            </tr>
          ))}
          {rooms.length === 0 && (
            <tr>
              <td colSpan={4} className="dim">
                no rooms yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {newKey && (
        <KeyReveal
          roomKey={newKey}
          onClose={() => setNewKey(null)}
          onJoinBrowser={(key) => {
            setNewKey(null);
            setChatOpen(key);
          }}
        />
      )}
    </div>
  );
}

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const check = useCallback(async () => {
    try {
      setMe(await api<Me>("/auth/me"));
    } catch {
      setMe(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    api<Config>("/config").then(setConfig).catch(() => {});
    check();
  }, [check]);

  if (loading || !config) return <div className="center dim">loading...</div>;
  if (!me) return <Landing config={config} onLogin={check} />;
  return <Rooms me={me} onLogout={() => setMe(null)} />;
}
