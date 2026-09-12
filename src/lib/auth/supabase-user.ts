/**
 * Maps an authenticated Supabase user to the LeadFlow `UserDTO` shape so
 * Supabase-authenticated visitors flow through the same DAL, dashboard, and
 * tenancy guards as database-session users. All tenant scoping stays keyed
 * by `user.id` (the Supabase `auth.users` UUID), so workspace isolation is
 * unchanged.
 *
 * Server-only. Returns null when Supabase is unconfigured or when any step
 * fails — callers treat that as unauthenticated, never as an error.
 */
import { env } from "../env";
import { createClient } from "../supabase/server";
import type { UserDTO } from "./users";

export async function getSupabaseUser(): Promise<UserDTO | null> {
  try {
    if (!env.isSupabaseConfigured) return null;
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    const u = data?.user;
    if (error || !u || !u.email) return null;
    const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
    const fullName =
      typeof meta["full_name"] === "string" && meta["full_name"].trim().length > 0
        ? (meta["full_name"] as string).trim()
        : typeof meta["name"] === "string" && meta["name"].trim().length > 0
          ? (meta["name"] as string).trim()
          : null;
    // OAuth avatar: Google/Facebook share `avatar_url` (Google also sends
    // `picture`). Used for display only — never written back anywhere.
    const avatarUrl =
      typeof meta["avatar_url"] === "string" && meta["avatar_url"].startsWith("https://")
        ? (meta["avatar_url"] as string)
        : typeof meta["picture"] === "string" && meta["picture"].startsWith("https://")
          ? (meta["picture"] as string)
          : null;
    const appMeta = (u.app_metadata ?? {}) as Record<string, unknown>;
    return {
      id: u.id,
      email: u.email,
      name: fullName,
      status: "ACTIVE",
      createdAt: u.created_at,
      emailVerifiedAt: u.email_confirmed_at ?? null,
      avatarUrl,
      authProvider:
        typeof appMeta["provider"] === "string" ? (appMeta["provider"] as string) : null,
    };
  } catch {
    return null;
  }
}
