/**
 * Route Handler helpers for auth endpoints. Translates framework-free
 * `ServiceResult`s into HTTP responses. All unexpected failures become a
 * generic 500 — stack traces and request details never reach the client.
 */
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, sessionCookieAttributes } from "./cookies";
import type { ServiceResult } from "./service";

const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,45}$/;

function asValidIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (v.length === 0 || v.length > 45) return null;
  if (IPV4_RE.test(v)) return v;
  // IPv6: must contain a colon and parse as hex/colons only.
  if (v.includes(":") && IPV6_RE.test(v)) return v;
  return null;
}

/**
 * Best-effort client IP for rate-limit keys. `X-Forwarded-For` /
 * `X-Real-IP` are client-controlled unless the deployment strips them at
 * a trusted edge proxy, so values are strictly validated (valid IPv4/IPv6
 * only, else "unknown") and IP limits are always paired with per-email /
 * per-account buckets (see service.ts) so rotating the header alone never
 * resets the budget. Set TRUST_PROXY=true only when a trusted edge
 * overwrites these headers; otherwise they are still read but untrusted
 * input collapses to the shared "unknown" bucket on validation failure.
 */
export function getClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim() ?? "";
    const valid = asValidIp(first);
    if (valid) return valid;
    return "unknown";
  }
  const realIp = asValidIp(headers.get("x-real-ip"));
  if (realIp) return realIp;
  return "unknown";
}

export function applyServiceResult(result: ServiceResult): NextResponse {
  const res = NextResponse.json(result.body, { status: result.status });
  if (result.retryAfterMs !== undefined) {
    res.headers.set("Retry-After", String(result.retryAfterMs));
  }
  if (result.setCookie) {
    res.cookies.set(
      SESSION_COOKIE_NAME,
      result.setCookie.value,
      sessionCookieAttributes(result.setCookie.maxAge)
    );
  }
  if (result.clearCookie) {
    res.cookies.set(SESSION_COOKIE_NAME, "", {
      ...sessionCookieAttributes(0),
      maxAge: 0,
    });
  }
  return res;
}

export function internalError(context: string, err: unknown): NextResponse {
  // Log for operators; never include request bodies, emails, or tokens.
  console.error(`[auth] ${context} failed`, {
    message: err instanceof Error ? err.message : "unknown",
  });
  return NextResponse.json({ error: "Internal server error." }, { status: 500 });
}

export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/**
 * Defense-in-depth CSRF check for cookie-authenticated state changes.
 * SameSite=Lax already blocks cross-site cookie sends on POST/PATCH, but
 * an explicit Origin/Referer match closes gaps (older browsers, future
 * SameSite changes, top-level login CSRF). Requests without Origin/Referer
 * (curl, same-origin form posts without Origin) pass; a present Origin
 * that does not match the app host is rejected. Callers map `false` to 403.
 */
export function isAllowedRequestOrigin(req: Request, appOrigin: string): boolean {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  if (!origin && !referer) return true;
  try {
    const expected = new URL(appOrigin);
    if (origin) {
      const got = new URL(origin);
      if (got.origin !== expected.origin) return false;
    }
    if (referer) {
      const got = new URL(referer);
      if (got.origin !== expected.origin) return false;
    }
    return true;
  } catch {
    return false;
  }
}
