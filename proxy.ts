/**
 * Next.js Proxy (formerly Middleware): optimistic auth checks only.
 *
 * Verifies the session cookie's signature + expiry WITHOUT a database
 * round-trip. Full verification (revocation, user status) always happens in
 * the DAL (`getCurrentUser`) / Route Handlers — a request that passes the
 * proxy with a revoked cookie is still rejected there.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, parseSessionCookie } from "./src/lib/auth/cookies";

const PROTECTED_PREFIXES = ["/dashboard", "/admin"];
const PROTECTED_API = ["/api/me", "/api/businesses", "/api/admin"];
const GUEST_ONLY = ["/login", "/register"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const raw = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  let signedIn = false;
  try {
    signedIn = (await parseSessionCookie(raw)) !== null;
  } catch {
    signedIn = false;
  }

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
    return NextResponse.next();
  }

  if (GUEST_ONLY.includes(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.searchParams.delete("next");
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/api/me", "/api/businesses/:path*", "/api/admin/:path*", "/login", "/register"],
};
