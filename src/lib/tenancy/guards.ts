/**
 * Route-handler guards for tenancy endpoints.
 * Translates auth + workspace context failures into HTTP responses.
 * Server-only: reads next/headers cookies like the auth DAL.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "../auth/cookies";
import { getSessionUser } from "../auth/sessions";
import type { UserDTO } from "../auth/users";
import { getRequestedBusinessId, resolveBusinessContext, type BusinessContext } from "./context";
import { TenantAccessDenied, TenantConflict, TenantLimitExceeded, TenantNotFound } from "./policies";

export async function requireUser(): Promise<{ user: UserDTO } | { response: NextResponse }> {
  const store = await cookies();
  const user = await getSessionUser(store.get(SESSION_COOKIE_NAME)?.value);
  if (!user) {
    return { response: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  }
  return { user };
}

export interface GuardResult {
  user: UserDTO;
  context: BusinessContext;
}

/**
 * Full guard for workspace-scoped endpoints: authenticated user + verified
 * membership in the requested business. Failures:
 * - 401 unauthenticated
 * - 400 missing business selector
 * - 403 authenticated but not a member (no data leaked)
 */
export async function requireBusinessContext(req: Request): Promise<GuardResult | { response: NextResponse }> {
  const authed = await requireUser();
  if ("response" in authed) return authed;
  const requested = getRequestedBusinessId(req);
  if (!requested) {
    return {
      response: NextResponse.json(
        { error: "Select a business. Provide x-business-id header or ?businessId= query." },
        { status: 400 }
      ),
    };
  }
  const resolved = await resolveBusinessContext(authed.user.id, requested);
  if (!resolved.ok) {
    return { response: NextResponse.json({ error: "Access denied for this business." }, { status: 403 }) };
  }
  return { user: authed.user, context: resolved.context };
}

/** Map tenancy errors to status codes. TenantNotFound → 404 (no inference). */
export function tenancyErrorResponse(err: unknown): NextResponse {
  if (err instanceof TenantAccessDenied) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err instanceof TenantNotFound) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (err instanceof TenantConflict) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  if (err instanceof TenantLimitExceeded) {
    return NextResponse.json({ error: err.message }, { status: 402 });
  }
  console.error("[tenancy] failed", { message: err instanceof Error ? err.message : "unknown" });
  return NextResponse.json({ error: "Internal server error." }, { status: 500 });
}
