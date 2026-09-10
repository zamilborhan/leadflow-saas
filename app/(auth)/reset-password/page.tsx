"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthLayout } from "@/src/components/layout/auth-layout";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { LoadingState } from "@/src/components/ui/states";
import { validateSupabaseNewPassword, type FieldErrors } from "@/src/lib/auth/validation";
import { createClient } from "@/src/lib/supabase/client";

function ResetForm() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  // The recovery link passes through /auth/callback, which exchanges it for
  // a session. Without that session there is nothing to update.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase.auth.getSession();
        if (!cancelled) setHasSession(!!data.session);
      } catch {
        if (!cancelled) setHasSession(false);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = validateSupabaseNewPassword({ password, confirmPassword });
    setFieldErrors(parsed.errors);
    if (!parsed.ok || !parsed.value) return;
    setPending(true);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({
        password: parsed.value.password,
      });
      if (updateError) {
        setError(updateError.message || "Could not update your password. Request a new link.");
        return;
      }
      setDone(true);
      setTimeout(() => {
        router.push("/dashboard");
        router.refresh();
      }, 1500);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  const firstError = (key: string): string | null => fieldErrors[key]?.[0] ?? null;

  if (!ready) return <LoadingState label="Checking your link…" />;

  if (done) {
    return (
      <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800">
        Password updated. Taking you to your dashboard…
      </p>
    );
  }

  if (!hasSession) {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          This reset link is invalid or has expired. Request a new one to continue.
        </p>
        <p className="text-center text-sm">
          <a href="/forgot-password" className="font-medium text-brand-700 hover:text-brand-800">
            Request a new reset link
          </a>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <Field label="New password" hint="Minimum 8 characters." required error={firstError("password")}>
        <Input
          type="password"
          required
          autoComplete="new-password"
          minLength={8}
          placeholder="Choose a strong password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Field label="Confirm new password" required error={firstError("confirmPassword")}>
        <Input
          type="password"
          required
          autoComplete="new-password"
          placeholder="Repeat your new password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
      </Field>
      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
      <Button type="submit" loading={pending} className="w-full">
        {pending ? "Updating…" : "Update password"}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthLayout
      title="Reset password"
      subtitle="Choose a new password (minimum 8 characters)."
      footer={
        <>
          Remembered it?{" "}
          <a href="/login" className="font-medium text-brand-700 hover:text-brand-800">
            Log in
          </a>
        </>
      }
    >
      <Suspense fallback={<LoadingState label="Loading…" />}>
        <ResetForm />
      </Suspense>
    </AuthLayout>
  );
}
