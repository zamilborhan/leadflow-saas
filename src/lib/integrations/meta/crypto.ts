/**
 * Token encryption for stored OAuth credentials (AES-256-GCM via Web Crypto).
 *
 * Server-only: never import from client components. Ciphertext is the only
 * form that ever reaches the database, logs, or API responses — plaintext
 * tokens exist only in function-local scope during encrypt/decrypt calls.
 *
 * Wire format: `v1.<base64url iv>.<base64url ciphertext>` (12-byte IV).
 * Key material comes from `META_TOKEN_KEY` (64 hex chars or base64 of
 * 32 bytes), passed explicitly by callers (usually `env.metaTokenKey`).
 * Error messages never include key or token material.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class MetaCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaCryptoError";
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Parse and validate the configured encryption key (exactly 32 bytes). */
export async function importTokenKey(keyRaw: string): Promise<CryptoKey> {
  let bytes: Uint8Array | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(keyRaw)) {
    bytes = hexToBytes(keyRaw);
  } else {
    // Base64 (standard or URL-safe, padded or not).
    const std = keyRaw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
    try {
      const binary = atob(padded);
      const raw = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
      bytes = raw.length === 32 ? raw : null;
    } catch {
      bytes = null;
    }
  }
  if (!bytes || bytes.length !== 32) {
    throw new MetaCryptoError("META_TOKEN_KEY must be 32 bytes (64 hex chars or base64).");
  }
  return crypto.subtle.importKey("raw", bytes.buffer as ArrayBuffer, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypt a plaintext token. Returns the `v1.…` wire format. */
export async function encryptToken(plaintext: string, keyRaw: string): Promise<string> {
  if (!plaintext) throw new MetaCryptoError("Cannot encrypt an empty token.");
  const key = await importTokenKey(keyRaw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, key, textEncoder.encode(plaintext));
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ct))}`;
}

/** Decrypt a `v1.…` payload. Throws MetaCryptoError on any failure. */
export async function decryptToken(payload: string, keyRaw: string): Promise<string> {
  const parts = typeof payload === "string" ? payload.split(".") : [];
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
    throw new MetaCryptoError("Invalid encrypted token format.");
  }
  let iv: Uint8Array;
  let ct: Uint8Array;
  try {
    iv = base64UrlDecode(parts[1]);
    ct = base64UrlDecode(parts[2]);
  } catch {
    throw new MetaCryptoError("Invalid encrypted token format.");
  }
  if (iv.length !== 12) throw new MetaCryptoError("Invalid encrypted token format.");
  const key = await importTokenKey(keyRaw);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
      key,
      ct.buffer as ArrayBuffer
    );
    return textDecoder.decode(pt);
  } catch {
    // Wrong key or tampered payload — identical generic message either way.
    throw new MetaCryptoError("Failed to decrypt token.");
  }
}

/** True when a stored value looks like Meta ciphertext (never plaintext). */
export function isEncryptedToken(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("v1.") && value.split(".").length === 3;
}
