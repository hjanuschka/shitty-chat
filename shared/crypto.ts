// E2E crypto shared by browser dashboard and pi extension.
// Uses WebCrypto only (globalThis.crypto), works in browser and Node 20+.
//
// roomKey = sc_<base58(32 random bytes)>       generated client-side
// authKey = HKDF(roomKey, info=auth/v1)        presented to relay
// e2eKey  = HKDF(roomKey, info=e2e/v1)         AES-256-GCM content key
// server stores sha256(authKeyHex) only.

import type { EncBlob } from "./protocol";

const te = new TextEncoder();
const td = new TextDecoder();

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function base58Encode(bytes: Uint8Array): string {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  let out = "";
  while (x > 0n) {
    out = B58[Number(x % 58n)] + out;
    x /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function generateRoomKey(): string {
  return `sc_${base58Encode(randomBytes(32))}`;
}

export interface DerivedKeys {
  authKeyHex: string;
  e2eKey: Uint8Array;
}

export async function deriveKeys(roomKey: string): Promise<DerivedKeys> {
  const master = await globalThis.crypto.subtle.importKey(
    "raw",
    te.encode(roomKey),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derive = async (info: string) =>
    new Uint8Array(
      await globalThis.crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode(info) },
        master,
        256,
      ),
    );
  const authKey = await derive("shitty.chat/auth/v1");
  const e2eKey = await derive("shitty.chat/e2e/v1");
  return { authKeyHex: toHex(authKey), e2eKey };
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", te.encode(s));
  return toHex(new Uint8Array(d));
}

export async function seal(e2eKey: Uint8Array, plaintext: string, aad: string): Promise<EncBlob> {
  const key = await globalThis.crypto.subtle.importKey("raw", e2eKey as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const n = randomBytes(12);
  const c = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: n as BufferSource, additionalData: te.encode(aad) },
      key,
      te.encode(plaintext),
    ),
  );
  return { n: toB64(n), c: toB64(c) };
}

export async function openBlob(e2eKey: Uint8Array, blob: EncBlob, aad: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey("raw", e2eKey as BufferSource, "AES-GCM", false, [
    "decrypt",
  ]);
  const pt = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(blob.n) as BufferSource, additionalData: te.encode(aad) },
    key,
    fromB64(blob.c) as BufferSource,
  );
  return td.decode(pt);
}
