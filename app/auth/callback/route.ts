/**
 * Supabase auth callback: exchanges the `code` from email confirmation,
 * password-recovery, and OAuth (Google) links for a session, then redirects.
 *
 * - `?next=` selects the destination (restricted to local paths).
 * - Default destination (`/dashboard`) is workspace-aware: users who own no
 *   workspace go to `/create-workspace` instead. Explicit deep links
 *   (e.g. `/reset-password`) are always respected.
 * - Provider refusals (`?error=`, e.g. cancelled Google consent) and bad
 *   codes land on `/login` with an `?error=` code; nothing secret leaks.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/src/lib/supabase/server";
import { listUserBusinesses } from "@/src/lib/tenancy/businesses";

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw.slice(0, 200);
}

function loginUrl(req: Request, error: string): NextResponse {
  const url = new URL("/login", req.url);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url);
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  // Google refusal (user cancelled consent, provider error): no code issued.
  if (!url.searchParams.get("code") && url.searchParams.get("error")) {
    const cancelled = url.searchParams.get("error") === "access_denied";
    return loginUrl(req, cancelled ? "oauth_cancelled" : "oauth_failed");
  }

  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));
  if (!code) return loginUrl(req, "callback_invalid_link");

  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return loginUrl(req, "callback_not_configured");
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return loginUrl(req, "callback_expired");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return loginUrl(req, "callback_expired");

  // Facebook (and occasionally other providers) can authenticate without
  // sharing an email address. LeadFlow keys identity, invites, and
  // notifications by email, so an email-less session is unusable: end it
  // immediately and explain, instead of bouncing the user between the
  // dashboard guard and login.
  if (!user.email) {
    await supabase.auth.signOut();
    return loginUrl(req, "oauth_no_email");
  }

  // Same sign-in / first-registration flow, so one rule: a fresh account owns
  // no workspace and must create one before the dashboard is useful.
  if (next === "/dashboard") {
    try {
      const businesses = await listUserBusinesses(user.id).catch(() => []);
      if (businesses.length === 0) {
        return NextResponse.redirect(new URL("/create-workspace", req.url));
      }
    } catch {
      // Fail open: a workspace-list hiccup must not trap a signed-in user.
    }
  }

  return NextResponse.redirect(new URL(next, req.url));
}
