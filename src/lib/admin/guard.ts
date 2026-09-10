/**
 * Super-admin route guard (server-only).
 *
 * Platform access is granted ONLY by the SUPER_ADMIN_EMAILS environment
 * allowlist — workspace roles (OWNER/ADMIN/SALES) never confer it, and no
 * session, cookie, or request field can substitute for allowlist
 * membership. Every /api/admin/* handler and the /app/admin layout go
 * through `requireSuperAdmin`.
 */
import { cookies } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "../auth/cookies";
import { getCurrentUser } from "../auth/dal";
import { getSessionUser } from "../auth/sessions";
import type { UserDTO } from "../auth/users";
import { env } from "../env";
import { isSuperAdminEmail } from "./allowlist";

/** Thrown when a caller is authenticated but not a super-admin. Maps to 403. */
export class SuperAdminAccessDenied extends Error {
  constructor(message = "Super-admin access required.") {
    super(message);
    this.name = "SuperAdminAccessDenied";
  }
}

function allowlistRaw(): string | undefined {
  const list = env.superAdminEmails;
  return list.length > 0 ? list.join(",") : undefined;
}

/** Platform check used by pages and API routes alike. */
export function isSuperAdmin(user: Pick<UserDTO, "email"> | null | undefined): boolean {
  if (!user) return false;
  return isSuperAdminEmail(user.email, allowlistRaw());
}

export interface SuperAdminGuardResult {
  user: UserDTO;
}

/**
 * Full guard for platform admin endpoints: authenticated session +
 * allowlisted email. Failures:
 * - 401 unauthenticated
 * - 403 authenticated but not a super-admin (no data leaked)
 */
export async function requireSuperAdmin(): Promise<SuperAdminGuardResult | { response: NextResponse }> {
  const store = await cookies();
  const user = await getSessionUser(store.get(SESSION_COOKIE_NAME)?.value);
  if (!user) {
    return { response: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  }
  if (!isSuperAdmin(user)) {
    return { response: NextResponse.json({ error: "Super-admin access required." }, { status: 403 }) };
  }
  return { user };
}

/** Map admin errors to status codes. */
export function superAdminErrorResponse(err: unknown): NextResponse {
  if (err instanceof SuperAdminAccessDenied) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  console.error("[admin] failed", { message: err instanceof Error ? err.message : "unknown" });
  return NextResponse.json({ error: "Internal server error." }, { status: 500 });
}

/**
 * Page-level gate for /admin Server Components. Every admin page MUST
 * `await` this BEFORE any platform data fetch.
 *
 * Why not rely on the /admin layout alone: siblings in the React tree
 * render concurrently, so a page's queries can execute (and land in the
 * flight payload) before the layout's own guard resolves — the visible UI
 * would still be the 403 fallback, but platform data would leak into the
 * response body. Awaiting this first makes authorization strictly precede
 * data fetching within the component: unauthenticated → login redirect,
 * authenticated non-admin → `forbidden()` (real 403, no fetch runs).
 */
export async function requireSuperAdminForPage(nextPath = "/admin"): Promise<UserDTO> {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${nextPath}`);
  if (!isSuperAdmin(user)) forbidden();
  return user;
}
