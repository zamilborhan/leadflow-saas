import { NextResponse } from "next/server";
import {
  authorizeUrl,
  codeChallenge,
  isOAuthProvider,
  newCodeVerifier,
  providerConfig,
  signState,
  type OAuthProvider,
} from "@/src/lib/auth/oauth";
import { env } from "@/src/lib/env";
import { normalizeNextPath } from "@/src/lib/auth/callback-destination";

function safeNext(raw: string | null): string {
  return normalizeNextPath(raw) ?? "/dashboard";
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
    return NextResponse.json(
      { error: `Sign in with ${p} is not configured. Set ${cfg.missing}.` },
      { status: 503 }
    );
  }
  const url = new URL(req.url);
  const { state, nonce } = await signState(p, safeNext(url.searchParams.get("next")));
  const verifier = p === "google" ? newCodeVerifier() : null;
  const res = NextResponse.redirect(
    await authorizeUrl(p, {
      state,
      ...(verifier ? { codeChallenge: await codeChallenge(verifier) } : {}),
    })
  );
  // Flow-bound cookies (10-min life): state mirror + PKCE verifier (Google).
  // The callback reads these back; `state` itself is HMAC-verified.
  res.cookies.set(`oauth_state_${nonce}`, state, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  if (verifier) {
    res.cookies.set(`oauth_pkce_${nonce}`, verifier, {
      httpOnly: true,
      secure: env.isProduction,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
  }
  return res;
}
