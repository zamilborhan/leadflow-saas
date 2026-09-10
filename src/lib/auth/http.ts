/**
 * Route Handler helpers for auth endpoints. Translates framework-free
 * `ServiceResult`s into HTTP responses. All unexpected failures become a
 * generic 500 — stack traces and request details never reach the client.
 */
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, sessionCookieAttributes } from "./cookies";
import type { ServiceResult } from "./service";

export function getClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
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
