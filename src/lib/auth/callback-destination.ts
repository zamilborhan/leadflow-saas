/**
 * Post-authentication destination policy (import-free: safe for client
 * components, route handlers, and direct unit tests).
 *
 * Allowlist (exact or subpath; query strings preserved):
 * - `/dashboard` — the default; workspace-aware (see below).
 * - `/onboarding/workspace` — explicit onboarding resumes.
 * - `/reset-password` — password-recovery flow target.
 * - `/admin` — platform area (its own layout enforces the super-admin
 *   allowlist with a real 403, so respecting the deep link is safe).
 *
 * Anything else (external URLs, protocol-relative `//host`, backslash
 * tricks like `/\evil.com`, unlisted app paths) is rejected. Rejection and
 * the bare default both resolve workspace-aware: workspace → `/dashboard`,
 * none → `/onboarding/workspace`.
 */

const ALLOWED_PREFIXES = ["/dashboard", "/onboarding/workspace", "/reset-password", "/admin"] as const;

const MAX_NEXT_LENGTH = 200;

/**
 * Normalize a raw `next` value to a safe in-app destination, or null when it
 * must not be trusted. Never throws on attacker input.
 */
export function normalizeNextPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  // WHATWG URL treats backslashes as slashes: `/\evil.com` would escape.
  if (raw.includes("\\")) return null;
  const pathname = raw.split(/[?#]/)[0] ?? "";
  const clean = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const allowed = ALLOWED_PREFIXES.some((p) => clean === p || clean.startsWith(`${p}/`));
  if (!allowed) return null;
  return raw.slice(0, MAX_NEXT_LENGTH);
}

/** True when the destination is the bare dashboard (workspace rule applies). */
export function isDefaultDashboardDestination(normalized: string): boolean {
  const pathname = normalized.split(/[?#]/)[0] ?? "";
  const clean = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return clean === "/dashboard";
}

/**
 * Final destination after authentication.
 *
 * - Allowlisted explicit target (other than bare `/dashboard`) → respected:
 *   recovery and onboarding resumes depend on it.
 * - Bare `/dashboard`, missing, or rejected `next` → workspace-aware:
 *   `hasWorkspace` decides between `/dashboard` and `/onboarding/workspace`
 *   (fail-closed to onboarding, never pretending a workspace exists).
 */
export function resolveCallbackDestination(
  rawNext: string | null | undefined,
  hasWorkspace: boolean
): string {
  const normalized = normalizeNextPath(rawNext);
  if (normalized !== null && !isDefaultDashboardDestination(normalized)) {
    return normalized;
  }
  return hasWorkspace ? "/dashboard" : "/onboarding/workspace";
}
