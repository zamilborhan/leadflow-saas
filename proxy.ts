/**
 * Next.js Proxy (formerly Middleware): optimistic auth checks only.
 *
 * Verifies the session cookie's signature + expiry WITHOUT a database
 * round-trip. Full verification (revocation, user status) always happens in
 * the DAL (`getCurrentUser`) / Route Handlers — a request that passes the
 * proxy with a revoked cookie is still rejected there.
 *
 * Pass-through responses also refresh the Supabase session
 * (`updateSupabaseSession`) when Supabase is configured. Signed-in means a
 * valid `lf_session` cookie OR a valid Supabase session; full verification
 * always happens downstream in the DAL / Route Handlers.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, parseSessionCookie } from "./src/lib/auth/cookies";
import { updateSupabaseSession } from "./src/lib/supabase/middleware";

const PROTECTED_PREFIXES = ["/dashboard", "/admin", "/onboarding"];
const PROTECTED_API = ["/api/me", "/api/businesses", "/api/admin"];
const GUEST_ONLY = ["/login", "/register"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const raw = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  let legacySignedIn = false;
  try {
    legacySignedIn = (await parseSessionCookie(raw)) !== null;
  } catch {
    legacySignedIn = false;
  }

  // Supabase refresh doubles as the optimistic Supabase check: a valid
  // Supabase session also counts as signed-in. Unconfigured it returns
  // `{ response: next(), user: null }` with no network call.
  const { response: sessionResponse, user: supabaseUser } =
    await updateSupabaseSession(request);
  const signedIn = legacySignedIn || supabaseUser !== null;

  if (!signedIn) {
    if (PROTECTED_API.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    if (PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
    // Public path: pass through with any refreshed Supabase cookies.
    return sessionResponse;
  }

  if (GUEST_ONLY.includes(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.searchParams.delete("next");
    return NextResponse.redirect(url);
  }
  return sessionResponse;
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/onboarding/:path*", "/api/me", "/api/businesses/:path*", "/api/admin/:path*", "/login", "/register"],
};
