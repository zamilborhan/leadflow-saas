/**
 * Email/password authentication logic for the login/register pages.
 *
 * UI-free: pages own state, validation messages, and navigation; everything
 * Supabase lives here so it is written once and reused. Passwords are never
 * stored — they go straight to Supabase Auth. All failures resolve to
 * user-friendly messages (never raw stack traces or secrets).
 */
import { createClient } from "@/src/lib/supabase/client";

function friendlySignInError(message: string): string {
  if (/invalid login credentials/i.test(message)) return "Invalid email or password.";
  if (/email not confirmed/i.test(message)) {
    return "Please verify your email first — check your inbox for the confirmation link.";
  }
  return message || "Sign-in failed. Please try again.";
}

function friendlySignUpError(message: string): string {
  if (/user already registered|already exists/i.test(message)) {
    return "An account with this email already exists. Try signing in instead.";
  }
  return message || "Registration failed. Please try again.";
}

/** Email/password sign-in. */
export async function emailSignIn(
  email: string,
  password: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  let supabase;
  try {
    supabase = createClient();
  } catch {
    return { ok: false, message: "Sign-in is not configured yet. Contact support." };
  }
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, message: friendlySignInError(error.message) };
    return { ok: true };
  } catch {
    return { ok: false, message: "Network error. Please try again." };
  }
}

export type EmailSignUpResult =
  | { status: "signed-in" }
  | { status: "check-email"; email: string }
  | { status: "error"; message: string };

/**
 * Email/password registration. Stores the full name in Supabase user
 * metadata (`full_name`). Resolves to `signed-in` when email confirmation is
 * off, or `check-email` when the account must verify first (never a session
 * for unverified users).
 */
export async function emailSignUp(
  name: string,
  email: string,
  password: string,
  emailRedirectTo: string
): Promise<EmailSignUpResult> {
  let supabase;
  try {
    supabase = createClient();
  } catch {
    return { status: "error", message: "Registration is not configured yet. Contact support." };
  }
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: name }, emailRedirectTo },
    });
    if (error) return { status: "error", message: friendlySignUpError(error.message) };
    if (data.session) return { status: "signed-in" };
    return { status: "check-email", email };
  } catch {
    return { status: "error", message: "Network error. Please try again." };
  }
}

/**
 * Email of the currently authenticated Supabase user, or null when signed
 * out, email-less, unconfigured, or offline. Used to bounce signed-in users
 * away from the login/register forms.
 */
export async function getAuthenticatedEmail(): Promise<string | null> {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user?.email ?? null;
  } catch {
    return null;
  }
}
