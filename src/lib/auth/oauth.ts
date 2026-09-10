/**
 * Social login for user auth (Google + Facebook sign-in/registration).
 *
 * Distinct from Meta Lead Ads OAuth (`src/lib/integrations/meta/`), which is
 * per-workspace. This module is per-user: it links a provider identity to a
 * LeadFlow `User` via `OAuthAccount` and signs the user in with the standard
 * database session.
 *
 * Security:
 * - `state` is HMAC-signed (`env.nextAuthSecret`), 10-min expiry, binds a
 *   random nonce + post-login `next` path. Callback verifies before any token
 *   exchange (CSRF protection).
 * - Google uses PKCE S256; the verifier lives in an httpOnly cookie bound to
 *   the same flow (`oauth_pkce_<nonce>`).
 * - Provider tokens stay function-local: exchanged for a profile, then
 *   dropped. Only provider user id + email snapshot persist.
 */
import { env } from "../env";
import { createUser, findUserByEmail, toUserId } from "./users";
import { OAuthAccountTable, UserTable } from "../../prisma/tables";

export const OAUTH_PROVIDERS = ["google", "facebook"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(v: unknown): v is OAuthProvider {
  return v === "google" || v === "facebook";
}

const textEncoder = new TextEncoder();
const STATE_TTL_MS = 10 * 60 * 1000;

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Uint8Array {
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

export interface OAuthState {
  provider: OAuthProvider;
  nonce: string;
  next: string;
  exp: number;
}

export async function signState(
  provider: OAuthProvider,
  next: string,
  secret: string = env.nextAuthSecret,
  nowMs: number = Date.now()
): Promise<{ state: string; nonce: string }> {
  const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const payload = { provider, nonce, next, exp: nowMs + STATE_TTL_MS };
  const encoded = b64urlEncode(textEncoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(`v1.${encoded}`));
  return { state: `v1.${encoded}.${b64urlEncode(new Uint8Array(sig))}`, nonce };
}

export async function verifyState(
  value: string | undefined | null,
  provider: OAuthProvider,
  secret: string = env.nextAuthSecret,
  nowMs: number = Date.now()
): Promise<OAuthState | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return null;
  const [, encoded, sig] = parts;
  const key = await hmacKey(secret);
  let sigBytes: Uint8Array;
  let payloadBytes: Uint8Array;
  try {
    sigBytes = b64urlDecode(sig);
    payloadBytes = b64urlDecode(encoded);
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
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    rec["provider"] !== provider ||
    typeof rec["nonce"] !== "string" ||
    typeof rec["next"] !== "string" ||
    typeof rec["exp"] !== "number" ||
    !Number.isSafeInteger(rec["exp"]) ||
    (rec["exp"] as number) <= nowMs
  ) {
    return null;
  }
  return {
    provider,
    nonce: rec["nonce"] as string,
    next: rec["next"] as string,
    exp: rec["exp"] as number,
  };
}

/** PKCE S256 helpers (Google). */
export function newCodeVerifier(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(verifier));
  return b64urlEncode(new Uint8Array(digest));
}

export interface ProviderConfig {
  configured: boolean;
  clientId?: string;
  clientSecret?: string;
  missing?: string;
}

export function providerConfig(provider: OAuthProvider): ProviderConfig {
  if (provider === "google") {
    const clientId = env.googleClientId;
    const clientSecret = env.googleClientSecret;
    if (!clientId || !clientSecret) return { configured: false, missing: "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET" };
    return { configured: true, clientId, clientSecret };
  }
  const clientId = env.facebookClientId;
  const clientSecret = env.facebookClientSecret;
  if (!clientId || !clientSecret) {
    return { configured: false, missing: "FACEBOOK_CLIENT_ID/FACEBOOK_CLIENT_SECRET (or META_APP_ID/META_APP_SECRET)" };
  }
  return { configured: true, clientId, clientSecret };
}

export function redirectUri(provider: OAuthProvider): string {
  return `${env.appUrl}/api/auth/oauth/${provider}/callback`;
}

export async function authorizeUrl(
  provider: OAuthProvider,
  opts: { state: string; codeChallenge?: string }
): Promise<string> {
  const cfg = providerConfig(provider);
  if (!cfg.configured) throw new Error(`[oauth] ${provider} not configured`);
  const redirect = redirectUri(provider);
  if (provider === "google") {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", cfg.clientId!);
    u.searchParams.set("redirect_uri", redirect);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "openid email profile");
    u.searchParams.set("state", opts.state);
    u.searchParams.set("code_challenge", opts.codeChallenge!);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("access_type", "online");
    u.searchParams.set("prompt", "select_account");
    return u.toString();
  }
  const u = new URL("https://www.facebook.com/v26.0/dialog/oauth");
  u.searchParams.set("client_id", cfg.clientId!);
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "email,public_profile");
  u.searchParams.set("state", opts.state);
  return u.toString();
}

export interface ProviderProfile {
  providerUserId: string;
  email: string;
  name?: string;
  emailVerified: boolean;
}

async function exchangeCode(
  provider: OAuthProvider,
  code: string,
  codeVerifier?: string
): Promise<string> {
  const cfg = providerConfig(provider);
  if (!cfg.configured) throw new Error(`[oauth] ${provider} not configured`);
  const body = new URLSearchParams();
  body.set("client_id", cfg.clientId!);
  body.set("client_secret", cfg.clientSecret!);
  body.set("code", code);
  body.set("redirect_uri", redirectUri(provider));
  body.set("grant_type", "authorization_code");
  if (provider === "google" && codeVerifier) body.set("code_verifier", codeVerifier);
  const tokenUrl =
    provider === "google"
      ? "https://oauth2.googleapis.com/token"
      : "https://graph.facebook.com/v26.0/oauth/access_token";
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`[oauth] ${provider} token exchange failed: ${res.status}`);
  const data = (await res.json()) as { access_token?: string; error?: unknown };
  if (!data.access_token) throw new Error(`[oauth] ${provider} token exchange returned no access token`);
  return data.access_token;
}

async function fetchProfile(provider: OAuthProvider, accessToken: string): Promise<ProviderProfile> {
  if (provider === "google") {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`[oauth] google userinfo failed: ${res.status}`);
    const data = (await res.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    };
    if (!data.sub || !data.email) throw new Error("[oauth] google profile missing sub/email");
    return {
      providerUserId: data.sub,
      email: data.email.toLowerCase().trim(),
      ...(data.name ? { name: data.name } : {}),
      emailVerified: data.email_verified === true,
    };
  }
  const u = new URL("https://graph.facebook.com/me");
  u.searchParams.set("fields", "id,name,email");
  u.searchParams.set("access_token", accessToken);
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`[oauth] facebook profile failed: ${res.status}`);
  const data = (await res.json()) as { id?: string; email?: string; name?: string };
  if (!data.id || !data.email) throw new Error("[oauth] facebook profile missing id/email");
  return {
    providerUserId: data.id,
    email: data.email.toLowerCase().trim(),
    ...(data.name ? { name: data.name } : {}),
    // Facebook only returns emails it has verified for the account.
    emailVerified: true,
  };
}

export interface LinkResult {
  userId: string;
  isNewUser: boolean;
  businessId: string | null;
}

/**
 * Link-or-create: existing OAuthAccount → that user; else email match →
 * link; else create verified user + OAuthAccount. New users get an
 * auto-created workspace (best-effort, same policy as email registration).
 */
export async function linkOrCreate(profile: ProviderProfile, provider: OAuthProvider): Promise<LinkResult> {
  const existing = await OAuthAccountTable.where((o) => o.provider.eq(provider))
    .where((o) => o.providerUserId.eq(profile.providerUserId))
    .select("userId")
    .first();
  if (existing) return { userId: existing.userId, isNewUser: false, businessId: null };

  const byEmail = await findUserByEmail(profile.email);
  if (byEmail) {
    try {
      await OAuthAccountTable.create({
        userId: toUserId(byEmail.id),
        provider,
        providerUserId: profile.providerUserId,
        email: profile.email,
      });
    } catch {
      // Race: another request linked first — resolve to the linked user.
      const raced = await OAuthAccountTable.where((o) => o.provider.eq(provider))
        .where((o) => o.providerUserId.eq(profile.providerUserId))
        .select("userId")
        .first();
      if (raced) return { userId: raced.userId, isNewUser: false, businessId: null };
      throw new Error("[oauth] account link conflict");
    }
    if (profile.emailVerified && byEmail.emailVerifiedAt === null) {
      await UserTable.where({ id: toUserId(byEmail.id) }).update({
        emailVerifiedAt: new Date().toISOString(),
      });
    }
    return { userId: byEmail.id, isNewUser: false, businessId: null };
  }

  const user = await createUser({
    email: profile.email,
    ...(profile.name ? { name: profile.name } : {}),
    passwordHash: null,
    ...(profile.emailVerified ? { emailVerifiedAt: new Date().toISOString() } : {}),
  });
  await OAuthAccountTable.create({
    userId: toUserId(user.id),
    provider,
    providerUserId: profile.providerUserId,
    email: profile.email,
  });

  let businessId: string | null = null;
  try {
    const { ensureRoleSeeds } = await import("../tenancy/seeds");
    const { createBusiness } = await import("../tenancy/businesses");
    await ensureRoleSeeds();
    const base = profile.name?.trim() || profile.email.split("@")[0] || "My";
    const business = await createBusiness(user.id, `${base}'s workspace`.slice(0, 120));
    businessId = business.id;
  } catch (err) {
    console.warn("[oauth] auto workspace creation skipped", {
      message: err instanceof Error ? err.message : "unknown",
    });
  }
  return { userId: user.id, isNewUser: true, businessId };
}

/** Full callback exchange: code → access token → normalized profile. */
export async function exchangeProfile(
  provider: OAuthProvider,
  code: string,
  codeVerifier?: string
): Promise<ProviderProfile> {
  const accessToken = await exchangeCode(provider, code, codeVerifier);
  return fetchProfile(provider, accessToken);
}
