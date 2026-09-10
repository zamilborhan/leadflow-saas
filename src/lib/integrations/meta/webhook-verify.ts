/**
 * Webhook request validation per Meta's webhooks docs. Pure module (no
 * imports) so unit tests exercise it directly.
 *
 * Verification handshake (GET): Meta sends hub.mode=subscribe,
 * hub.verify_token, hub.challenge — echo the challenge iff mode is
 * "subscribe" and the token matches the configured verify token.
 *
 * Event delivery (POST): every payload carries X-Hub-Signature-256
 * (`sha256=<hex HMAC-SHA256 of the RAW body with the app secret>`).
 * Comparison is timing-safe. The raw body — not a re-serialization —
 * must be used, since any byte difference breaks the signature.
 */

const textEncoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Validate a webhook verification handshake. Returns the challenge to echo,
 * or null when the request must be rejected (never echo attacker input
 * unless it is a well-formed subscribe handshake).
 */
export function verifyHandshake(
  mode: string | null,
  verifyToken: string | null,
  challenge: string | null,
  expectedToken: string
): string | null {
  if (mode !== "subscribe") return null;
  if (!verifyToken || !challenge) return null;
  if (verifyToken.length === 0 || expectedToken.length === 0) return null;
  const a = textEncoder.encode(verifyToken);
  const b = textEncoder.encode(expectedToken);
  if (!timingSafeEqual(a, b)) return null;
  return challenge;
}

/** Parse the X-Hub-Signature-256 header into raw signature bytes. */
export function parseSignatureHeader(value: string | null): Uint8Array | null {
  if (!value) return null;
  const prefix = "sha256=";
  if (!value.startsWith(prefix)) return null;
  return hexToBytes(value.slice(prefix.length));
}

/**
 * Verify a delivery signature over the raw request body. Returns false
 * (never throws) for missing/malformed headers so callers map it to 403.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string
): Promise<boolean> {
  const expected = parseSignatureHeader(signatureHeader);
  if (!expected || appSecret.length === 0) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const actual = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(rawBody))
  );
  return timingSafeEqual(actual, expected);
}
