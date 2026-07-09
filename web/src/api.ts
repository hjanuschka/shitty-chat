// When the web is served from the same origin as the API (single-container
// deploy) API_BASE is empty and we use relative paths. When the dashboard
// is deployed separately (e.g. Vercel) set VITE_API_URL at build time to
// your relay host, e.g. "https://api.shitty.chat".
export const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export function wsUrl(): string {
  const explicit = import.meta.env.VITE_WS_URL;
  if (explicit) return String(explicit);
  if (API_BASE) {
    return API_BASE.replace(/^http(s?):\/\//, "ws$1://") + "/ws";
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    method: options.method ?? "GET",
    headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { message?: string; error?: string }).message ?? (data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
