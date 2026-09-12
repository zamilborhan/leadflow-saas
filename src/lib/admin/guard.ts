/**
 * Super-admin route guard (server-only).
 *
 * Platform access is granted ONLY by the SUPER_ADMIN_EMAILS environment
 * allowlist — workspace roles (OWNER/ADMIN/SALES) never confer it, and no
 * session, cookie, or request field can substitute for allowlist
 * membership. Every /api/admin/* handler and the /app/admin layout go
 * through `requireSuperAdmin`.
 */
import { forbidden, redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { getCurrentUser } from "../auth/dal";
import type { UserDTO } from "../auth/users";
import { env } from "../env";
import { isSuperAdminEmail } from "./allowlist";
import { getAdminRoleForEmail, hasPermission, type AdminPermission, type AdminRole } from "./roles";

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
export function isSuperAdmin(
  user: Pick<UserDTO, "email" | "emailVerifiedAt"> | null | undefined
): boolean {
  if (!user) return false;
  // Allowlisted email alone is not enough: the address must be verified,
  // otherwise anyone who registers an allowlisted address in Supabase (or
  // any unverified DB row) would gain platform access.
  if (user.emailVerifiedAt === null) return false;
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
  // Bridged like every other guard, so a Supabase super-admin is authorized
  // exactly like a database-session one; the allowlist remains the authority.
  const user = await getCurrentUser();
  if (!user) {
    return { response: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  }
  if (!isSuperAdmin(user)) {
    return { response: NextResponse.json({ error: "Super-admin access required." }, { status: 403 }) };
  }
  // DB is authoritative for deactivation: a Supabase session (or stale DTO)
  // for an email whose DB account is suspended/revoked must not retain
  // platform access.
  try {
    const { findUserByEmail } = await import("../auth/users");
    const dbUser = await findUserByEmail(user.email);
    if (dbUser && dbUser.status !== "ACTIVE") {
      return { response: NextResponse.json({ error: "Super-admin access required." }, { status: 403 }) };
    }
  } catch {
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
  try {
    const { findUserByEmail } = await import("../auth/users");
    const dbUser = await findUserByEmail(user.email);
    if (dbUser && dbUser.status !== "ACTIVE") forbidden();
  } catch {
    forbidden();
  }
  return user;
}

/** Resolve the platform role for the current session (null = no access). */
export async function getCurrentAdminRole(): Promise<{ user: UserDTO; role: AdminRole } | null> {
  const user = await getCurrentUser();
  if (!user || !isSuperAdmin(user)) {
    if (!user) return null;
    // Non-allowlisted super-admin path: check extended roles. Extended
    // roles still require a verified, ACTIVE DB account.
    const role = getAdminRoleForEmail(user.email);
    if (!role || user.emailVerifiedAt === null) return null;
    try {
      const { findUserByEmail } = await import("../auth/users");
      const dbUser = await findUserByEmail(user.email);
      if (dbUser && dbUser.status !== "ACTIVE") return null;
    } catch {
      return null;
    }
    return { user, role };
  }
  return { user, role: getAdminRoleForEmail(user.email) ?? "SUPER_ADMIN" };
}

/**
 * Page-level gate for a specific permission. SUPER_ADMIN-only pages keep
 * using requireSuperAdminForPage; mixed-role pages use this.
 */
export async function requirePermissionForPage(
  permission: AdminPermission,
  nextPath = "/admin"
): Promise<{ user: UserDTO; role: AdminRole }> {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${nextPath}`);
  const role = getAdminRoleForEmail(user.email);
  if (!role || user.emailVerifiedAt === null) forbidden();
  if (!hasPermission(role, permission)) forbidden();
  try {
    const { findUserByEmail } = await import("../auth/users");
    const dbUser = await findUserByEmail(user.email);
    if (dbUser && dbUser.status !== "ACTIVE") forbidden();
  } catch {
    forbidden();
  }
  return { user, role: role as AdminRole };
}

/** API-level gate for a specific permission. Returns 401/403 responses. */
export async function requirePermission(
  permission: AdminPermission
): Promise<{ user: UserDTO; role: AdminRole } | { response: NextResponse }> {
  const g = await requireSuperAdmin();
  // requireSuperAdmin already enforces SUPER_ADMIN allowlist; extended
  // roles are checked here so BILLING_ADMIN etc. can reach scoped APIs.
  if ("response" in g) {
    const user = await getCurrentUser();
    const role = user ? getAdminRoleForEmail(user.email) : null;
    if (!user) return g;
    if (!role || !hasPermission(role, permission)) {
      return { response: NextResponse.json({ error: "Super-admin access required." }, { status: 403 }) };
    }
    return { user, role };
  }
  const role = getAdminRoleForEmail(g.user.email) ?? "SUPER_ADMIN";
  if (!hasPermission(role, permission)) {
    return { response: NextResponse.json({ error: "Insufficient admin permission." }, { status: 403 }) };
  }
  return { user: g.user, role };
}
