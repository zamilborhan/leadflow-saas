/**
 * Data Access Layer for auth — the single place server code learns "who is
 * calling". Follows the Next.js database-session pattern: the session cookie
 * is verified against the database on every call (secure check), and only a
 * minimal DTO (never passwordHash, tokens, or secrets) is returned.
 *
 * Server-only: imports next/headers. Never import from client components.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "./cookies";
import { getSessionUser } from "./sessions";
import { getSupabaseUser } from "./supabase-user";
import type { UserDTO } from "./users";

/**
 * Secure check: current user DTO, or null when unauthenticated.
 * Database sessions (`lf_session`) are checked first; Supabase sessions are
 * the fallback so Supabase-authenticated visitors reach the same pages and
 * guards. Unconfigured Supabase resolves to null with no network call.
 */
export async function getCurrentUser(): Promise<UserDTO | null> {
  const store = await cookies();
  const legacy = await getSessionUser(store.get(SESSION_COOKIE_NAME)?.value);
  if (legacy) return legacy;
  return getSupabaseUser();
}

/**
 * Page guard: redirects unauthenticated visitors to /login.
 * Use at the top of protected pages (e.g. /dashboard).
 */
export async function requireUserForPage(): Promise<UserDTO> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Thrown by requireUserForApi; Route Handlers translate it to 401. */
export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not authenticated.");
  }
}

/**
 * API guard: returns the user DTO or throws NotAuthenticatedError.
 * Catches nothing else — unexpected failures must surface as 500s, not 401s.
 */
export async function requireUserForApi(): Promise<UserDTO> {
  const user = await getCurrentUser();
  if (!user) throw new NotAuthenticatedError();
  return user;
}
