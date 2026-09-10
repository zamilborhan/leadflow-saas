"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthDivider, FacebookOAuthButton, GoogleOAuthButton } from "@/src/components/auth/oauth-buttons";
import { emailSignUp, getAuthenticatedEmail } from "@/src/components/auth/email-auth";
import { resolvePostAuthDestination } from "@/src/components/auth/post-auth";
import { AuthLayout } from "@/src/components/layout/auth-layout";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { LoadingState } from "@/src/components/ui/states";
import { validateSupabaseRegister, type FieldErrors } from "@/src/lib/auth/validation";

function RegisterForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const busy = pending || oauthBusy;

  // Already signed in → skip registration (email required, as on login).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const address = await getAuthenticatedEmail();
      if (!cancelled && address) {
        router.replace(await resolvePostAuthDestination("/dashboard"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = validateSupabaseRegister({ name, email, password, confirmPassword });
    setFieldErrors(parsed.errors);
    if (!parsed.ok || !parsed.value) return;
    setPending(true);
    try {
      const result = await emailSignUp(
        parsed.value.name,
        parsed.value.email,
        parsed.value.password,
        `${window.location.origin}/auth/callback?next=/dashboard`
      );
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      if (result.status === "signed-in") {
        // Email confirmation disabled: signed in immediately.
        router.push(await resolvePostAuthDestination("/dashboard"));
        router.refresh();
        return;
      }
      // Email confirmation enabled: no session yet — never enter the app
      // unverified. Show the check-email state on this page.
      setCheckEmail(result.email);
    } finally {
      setPending(false);
    }
  }

  const firstError = (key: string): string | null => fieldErrors[key]?.[0] ?? null;

  return (
    <AuthLayout
      title="Create your LeadFlow account"
      footer={
        <>
          Already have an account?{" "}
          <a href="/login" className="font-medium text-brand-700 hover:text-brand-800">
            Sign in
          </a>
        </>
      }
    >
      {checkEmail ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800">
            Account created! Check <span className="font-bold">{checkEmail}</span> for the
            confirmation link to verify your email.
          </p>
          <p className="text-sm text-slate-500">
            Didn&apos;t get it?{" "}
            <a href="/verify-email" className="font-medium text-brand-700 hover:text-brand-800">
              Resend the link
            </a>
          </p>
          <p className="text-center text-sm">
            <a href="/login" className="font-medium text-brand-700 hover:text-brand-800">
              Back to login
            </a>
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <GoogleOAuthButton
            next="/dashboard"
            disabled={pending}
            onError={setError}
            onPendingChange={setOauthBusy}
          />
          <FacebookOAuthButton
            next="/dashboard"
            disabled={pending}
            onError={setError}
            onPendingChange={setOauthBusy}
          />
          <AuthDivider />
          <Field label="Full name" required error={firstError("name")}>
            <Input
              type="text"
              required
              autoComplete="name"
              placeholder="Your full name"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
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
          <Field label="Password" hint="Minimum 8 characters." required error={firstError("password")}>
            <Input
              type="password"
              required
              autoComplete="new-password"
              minLength={8}
              placeholder="Create a strong password"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Confirm password" required error={firstError("confirmPassword")}>
            <Input
              type="password"
              required
              autoComplete="new-password"
              placeholder="Repeat your password"
              value={confirmPassword}
              disabled={busy}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </Field>
          {error ? (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {error}
            </p>
          ) : null}
          <Button type="submit" loading={pending} disabled={oauthBusy} className="w-full">
            {pending ? "Creating account…" : "Create account"}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading…" />}>
      <RegisterForm />
    </Suspense>
  );
}
