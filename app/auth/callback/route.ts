/**
 * Supabase auth callback: exchanges the `code` from email confirmation,
 * password-recovery, and OAuth (Google/Facebook) links for a session, then
 * redirects.
 *
 * - `?next=` selects the destination from a strict allowlist
 *   (`/dashboard`, `/onboarding/workspace`, `/reset-password`, `/admin`;
 *   see `src/lib/auth/callback-destination.ts`). Anything else falls back
 *   to the workspace-aware default below.
 * - Default: workspace exists → `/dashboard`; none → `/onboarding/workspace`
 *   (lookup failures fail closed to onboarding, never pretending).
 * - Email-less provider users are signed out with an explanatory login
 *   error instead of bouncing between guards.
 * - Provider refusals (`?error=`) and bad codes land on `/login` with an
 *   `?error=` code; nothing secret leaks.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/src/lib/supabase/server";
import { resolveCallbackDestination } from "@/src/lib/auth/callback-destination";
import { listUserBusinesses } from "@/src/lib/tenancy/businesses";

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

  // Same sign-in / first-registration flow, so one rule: resolve through
  // the shared destination policy (explicit allowlisted targets respected,
  // otherwise workspace-aware; lookup failures fail closed to onboarding).
  let hasWorkspace = false;
  try {
    const businesses = await listUserBusinesses(user.id).catch(() => []);
    hasWorkspace = businesses.length > 0;
  } catch {
    hasWorkspace = false;
  }
  return NextResponse.redirect(
    new URL(resolveCallbackDestination(url.searchParams.get("next"), hasWorkspace), req.url)
  );
}
