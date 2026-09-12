/**
 * Signed OAuth `state` for the Meta connect flow (Web Crypto HMAC-SHA256).
 *
 * The callback URL is a single fixed endpoint (Meta requires exact-match
 * redirect URIs), so per-request context — business, initiating user,
 * expiry — travels in `state`: `v1.<base64url json>.<base64url sig>`.
 * Callback verifies signature + expiry + that the session user matches,
 * which binds the flow against CSRF and cross-user fixation.
 *
 * Pure module (no project imports) so unit tests exercise it directly.
 * The HMAC secret is passed explicitly by callers (usually
 * `env.nextAuthSecret`).
 */

const textEncoder = new TextEncoder();

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthState {
  businessId: string;
  userId: string;
  nonce: string;
  exp: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const binary = atob(input.replace(/-/g, "+").replace(/_/g, "/"));
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

function randomNonce(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/** Mint a signed state value for (business, user). */
export async function signOAuthState(
  businessId: string,
  userId: string,
  opts: { secret: string; nowMs?: number; nonce?: string }
): Promise<string> {
  const nowMs = opts?.nowMs ?? Date.now();
  const payload: OAuthState = {
    businessId,
    userId,
    nonce: opts?.nonce ?? randomNonce(),
    exp: nowMs + OAUTH_STATE_TTL_MS,
  };
  const encoded = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(opts.secret);
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(`v1.${encoded}`));
  return `v1.${encoded}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/** Single-use nonce cache: nonce → expiry. Bounds replay within the TTL. */
const seenNonces = new Map<string, number>();

function pruneNonces(nowMs: number): void {
  if (seenNonces.size > 5000) {
    for (const [k, exp] of seenNonces) {
      if (exp <= nowMs) seenNonces.delete(k);
    }
  }
  if (seenNonces.size > 10000) seenNonces.clear();
}

/**
 * Consume a verified state nonce. Returns false when the nonce was already
 * used (replay) or is expired. Call only after signature verification.
 */
export function consumeOAuthNonce(nonce: string, exp: number, nowMs: number = Date.now()): boolean {
  pruneNonces(nowMs);
  if (exp <= nowMs) return false;
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, exp);
  return true;
}

/**
 * Verify a returned state value. Returns the payload, or null when the
 * format, signature, or expiry is wrong. Never throws on attacker input.
 * Note: single-use enforcement happens in the callback via
 * consumeOAuthNonce (verify-only callers such as pure parsers stay side-effect free).
 */
export async function verifyOAuthState(
  value: string | undefined | null,
  opts: { secret: string; nowMs?: number }
): Promise<OAuthState | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return null;
  const [, encoded, sig] = parts;
  const key = await hmacKey(opts.secret);
  let sigBytes: Uint8Array;
  let payloadBytes: Uint8Array;
  try {
    sigBytes = base64UrlDecode(sig);
    payloadBytes = base64UrlDecode(encoded);
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes.buffer as ArrayBuffer,
    textEncoder.encode(`v1.${encoded}`)
  );
  if (!valid) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  if (
    typeof rec["businessId"] !== "string" ||
    typeof rec["userId"] !== "string" ||
    typeof rec["nonce"] !== "string" ||
    typeof rec["exp"] !== "number" ||
    !Number.isSafeInteger(rec["exp"])
  ) {
    return null;
  }
  if (rec["exp"] <= (opts?.nowMs ?? Date.now())) return null;
  return { businessId: rec["businessId"], userId: rec["userId"], nonce: rec["nonce"], exp: rec["exp"] };
}
