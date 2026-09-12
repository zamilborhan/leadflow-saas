"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthDivider, FacebookOAuthButton, GoogleOAuthButton } from "@/src/components/auth/oauth-buttons";
import { emailSignIn, getAuthenticatedEmail } from "@/src/components/auth/email-auth";
import { resolvePostAuthDestination } from "@/src/components/auth/post-auth";
import { AuthLayout } from "@/src/components/layout/auth-layout";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { LoadingState } from "@/src/components/ui/states";
import { validateSupabaseLogin, type FieldErrors } from "@/src/lib/auth/validation";
import { normalizeNextPath } from "@/src/lib/auth/callback-destination";

const CALLBACK_ERRORS: Record<string, string> = {
  oauth_cancelled: "Social sign-in was cancelled. Try again or use email.",
  oauth_failed: "Social sign-in failed. Try again or use email.",
  provider_not_configured: "Social sign-in is not configured yet. Use email for now.",
  oauth_no_email:
    "Your social account didn't share an email address. Add one to that account, or continue with Google or email.",
  callback_invalid_link: "That link is invalid. Request a new one below.",
  callback_expired: "That link expired or was already used. Request a new one.",
  callback_not_configured: "Sign-in is not configured yet. Contact support.",
};

function safeNext(raw: string | null): string {
  // Shared allowlist (open-redirect safe); proxy only ever generates
  // protected paths, all covered, with dashboard as the fallback.
  return normalizeNextPath(raw) ?? "/dashboard";
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get("next"));
  const callbackError = CALLBACK_ERRORS[searchParams.get("error") ?? ""] ?? null;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const busy = pending || oauthBusy;

  // Already signed in (session persists across restarts) → skip login.
  // Requires an email: provider sessions without one are signed out by the
  // callback, and must never bounce between here and the dashboard guard.
  // The form renders only after the check, so signed-in users never see a
  // flash of the login card.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const address = await getAuthenticatedEmail();
      if (cancelled) return;
      if (address) {
        router.replace(await resolvePostAuthDestination(next));
        return;
      }
      setChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, next]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = validateSupabaseLogin({ email, password });
    setFieldErrors(parsed.errors);
    if (!parsed.ok || !parsed.value) return;
    setPending(true);
    try {
      const result = await emailSignIn(parsed.value.email, parsed.value.password);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.push(await resolvePostAuthDestination(next));
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  const firstError = (key: string): string | null => fieldErrors[key]?.[0] ?? null;

  return (
    <AuthLayout
      title="Welcome back"
      footer={
        <>
          Don&apos;t have an account?{" "}
          <a href="/register" className="font-medium text-brand-700 hover:text-brand-800">
            Sign up
          </a>
        </>
      }
    >
      {!checked ? (
        <LoadingState label="Checking your session…" />
      ) : (
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <GoogleOAuthButton
          next={next}
          disabled={pending}
          onError={setError}
          onPendingChange={setOauthBusy}
        />
        <FacebookOAuthButton
          next={next}
          disabled={pending}
          onError={setError}
          onPendingChange={setOauthBusy}
        />
        <AuthDivider />
        <Field label="Email" required error={firstError("email")}>
          <Input
            type="email"
            required
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            disabled={busy}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password" required error={firstError("password")}>
          <Input
            type="password"
            required
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error || callbackError ? (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
            {error ?? callbackError}
          </p>
        ) : null}
        <Button type="submit" loading={pending} disabled={oauthBusy} className="w-full">
          {pending ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-center text-sm">
          <a href="/forgot-password" className="font-medium text-brand-700 hover:text-brand-800">
            Forgot password?
          </a>
        </p>
      </form>
      )}
    </AuthLayout>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading…" />}>
      <LoginForm />
    </Suspense>
  );
}
