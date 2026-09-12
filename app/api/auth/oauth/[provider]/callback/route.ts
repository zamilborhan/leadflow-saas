import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  exchangeProfile,
  isOAuthProvider,
  linkOrCreate,
  providerConfig,
  verifyState,
  type OAuthProvider,
} from "@/src/lib/auth/oauth";
import { createSession } from "@/src/lib/auth/sessions";
import { SESSION_COOKIE_NAME, sessionCookieAttributes } from "@/src/lib/auth/cookies";
import { env } from "@/src/lib/env";

function loginUrl(error: string): URL {
  const u = new URL("/login", env.appUrl);
  u.searchParams.set("error", error);
  return u;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  if (!isOAuthProvider(provider)) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
  }
  const p: OAuthProvider = provider;
  const cfg = providerConfig(p);
  if (!cfg.configured) {
    return NextResponse.redirect(loginUrl("provider_not_configured"));
  }
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error") || !code || !state) {
    return NextResponse.redirect(loginUrl("oauth_cancelled"));
  }
  const verified = await verifyState(state, p);
  if (!verified) return NextResponse.redirect(loginUrl("oauth_invalid_state"));

  const store = await cookies();
  // Flow-bound cookies must mirror the returned state (binds CSRF token to
  // this browser); PKCE verifier restores Google's challenge.
  const stateCookie = store.get(`oauth_state_${verified.nonce}`)?.value;
  if (stateCookie !== state) return NextResponse.redirect(loginUrl("oauth_invalid_state"));
  const codeVerifier =
    p === "google" ? store.get(`oauth_pkce_${verified.nonce}`)?.value : undefined;
  if (p === "google" && !codeVerifier) {
    return NextResponse.redirect(loginUrl("oauth_invalid_state"));
  }

  let userId: string;
  let businessId: string | null;
  try {
    const profile = await exchangeProfile(p, code, codeVerifier);
    const linked = await linkOrCreate(profile, p);
    userId = linked.userId;
    businessId = linked.businessId;
  } catch (err) {
    console.warn(`[oauth] ${p} callback failed`, {
      message: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.redirect(loginUrl("oauth_failed"));
  }

  const session = await createSession(userId);
  // `verified.next` is HMAC-bound and minted only from allowlisted values,
  // but re-resolve through the allowlist here too so a signer bug can never
  // turn this redirect into an in-app phishing target or off-origin URL.
  const { normalizeNextPath: normalizeCallbackNext } = await import("@/src/lib/auth/callback-destination");
  const nextPath = normalizeCallbackNext(verified.next) ?? "/dashboard";
  const dest = new URL(nextPath, env.appUrl);
  if (businessId && dest.pathname === "/dashboard" && !dest.searchParams.get("businessId")) {
    dest.searchParams.set("businessId", businessId);
  }
  const res = NextResponse.redirect(dest);
  res.cookies.set(
    SESSION_COOKIE_NAME,
    session.cookieValue,
    sessionCookieAttributes(Math.floor((session.expiresAtMs - Date.now()) / 1000))
  );
  // Single-use flow cookies.
  res.cookies.set(`oauth_state_${verified.nonce}`, "", { path: "/", maxAge: 0 });
  if (p === "google") res.cookies.set(`oauth_pkce_${verified.nonce}`, "", { path: "/", maxAge: 0 });
  return res;
}
