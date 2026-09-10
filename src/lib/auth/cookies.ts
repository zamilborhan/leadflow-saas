/**
 * Session cookie signing (HMAC-SHA256 via Web Crypto — runs on Node and Edge,
 * so `proxy.ts` and the DAL share this exact implementation).
 *
 * Cookie value: v1.<token>.<expiresAtMs>.<signature>
 * where signature = base64url(HMAC(secret, "v1.<token>.<expiresAtMs>")).
 *
 * The token itself is opaque; the database stores only its SHA-256 hash.
 */
import { env } from "../env";

export const SESSION_COOKIE_NAME = "lf_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const textEncoder = new TextEncoder();

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

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return base64UrlEncode(new Uint8Array(sig));
}

/** Build a signed cookie value for an opaque token. */
export async function signSessionCookie(
  token: string,
  expiresAtMs: number,
  secret: string = env.nextAuthSecret
): Promise<string> {
  const payload = `v1.${token}.${expiresAtMs}`;
  const sig = await signPayload(payload, secret);
  return `${payload}.${sig}`;
}

export interface ParsedSessionCookie {
  token: string;
  expiresAtMs: number;
}

/**
 * Optimistic check: signature validity + expiry only (no database).
 * Used by `proxy.ts`. Full verification (revocation, user status) happens
 * in the DAL via `getSessionUser()`.
 */
export async function parseSessionCookie(
  value: string | undefined | null,
  secret: string = env.nextAuthSecret,
  nowMs: number = Date.now()
): Promise<ParsedSessionCookie | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, token, expRaw, sig] = parts;
  if (!token || !expRaw || !sig) return null;
  const expiresAtMs = Number(expRaw);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return null;
  const key = await hmacKey(secret);
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64UrlDecode(sig);
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes.buffer as ArrayBuffer,
    textEncoder.encode(`v1.${token}.${expRaw}`)
  );
  if (!valid) return null;
  return { token, expiresAtMs };
}

/** SHA-256 hex digest — how opaque tokens are stored in the database. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 256-bit opaque token, base64url-encoded (safe for cookies and URLs). */
export function generateOpaqueToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export interface SessionCookieAttributes {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
}

/** Cookie attributes shared by every place that sets the session cookie. */
export function sessionCookieAttributes(maxAgeSeconds: number): SessionCookieAttributes {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
