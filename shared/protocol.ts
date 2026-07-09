// Shared protocol types between relay server and pi extension.

export type EncBlob = { n: string; c: string };

export type AgentState = "active" | "muted" | "banned";
export type AgentRole = "master" | "slave";

export interface MemberInfo {
  agentId: string;
  name: string;
  platform: string;
  role: AgentRole;
  state: AgentState;
  connected: boolean;
  lastSeen: number;
}

export interface Envelope<T = unknown> {
  type: string;
  id?: string;
  from?: string;
  payload?: T;
}

// client -> relay

export interface HelloPayload {
  authKey: string; // hex, HKDF-derived; relay stores/compares sha256 of it
  identity: string; // agent identity secret (uuid), hashed server-side
  name: string;
  platform: string;
}

export interface AskPayload {
  askId: string;
  prompt: EncBlob; // aad: ask|<askId>
  context?: EncBlob; // aad: ctx|<askId>
  target: string; // "all" | agentId
  agentMode?: boolean; // hint: sender requests tool-using turn
}

export interface AskAckPayload {
  askId: string;
  status: "accepted" | "declined" | "busy";
}

export interface AskResponsePayload {
  askId: string;
  toAgentId: string;
  status: "running" | "final" | "error";
  chunk?: EncBlob; // aad: resp|<askId>|<responderAgentId>
  error?: string;
}

export interface ModerationPayload {
  targetAgentId: string;
}

export interface SayPayload {
  sayId: string;
  text: EncBlob; // aad: say|<sayId>|<senderAgentId>
}

export interface TurnPayload {
  turnId: string;
  prompt: EncBlob; // aad: turn|<turnId>|<senderAgentId>
  target: string; // "all" | agentId
}

export interface TurnResponsePayload {
  turnId: string;
  toAgentId: string;
  status: "running" | "final" | "error";
  chunk?: EncBlob; // aad: turnResp|<turnId>|<responderAgentId>
  error?: string;
}

// relay -> client

export interface WelcomePayload {
  agentId: string;
  role: AgentRole;
  roomName: string;
  members: MemberInfo[];
}

export interface MemberUpdatePayload {
  event: string;
  agentId?: string;
  members: MemberInfo[];
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface ByePayload {
  reason: "kicked" | "banned" | "key_rotated" | "room_deleted";
}

export const AAD = {
  ask: (askId: string) => `ask|${askId}`,
  ctx: (askId: string) => `ctx|${askId}`,
  resp: (askId: string, responder: string) => `resp|${askId}|${responder}`,
  say: (sayId: string, sender: string) => `say|${sayId}|${sender}`,
  turn: (turnId: string, sender: string) => `turn|${turnId}|${sender}`,
  turnResp: (turnId: string, responder: string) => `turnResp|${turnId}|${responder}`,
};
