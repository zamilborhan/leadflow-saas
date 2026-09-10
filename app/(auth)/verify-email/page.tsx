"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthLayout } from "@/src/components/layout/auth-layout";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { LoadingState } from "@/src/components/ui/states";
import { createClient } from "@/src/lib/supabase/client";

type Status = { kind: "idle" | "checking" | "ok" | "error"; message: string };

function VerifyForm() {
  const searchParams = useSearchParams();
  const confirmedParam = searchParams.get("confirmed") === "1";
  const [email, setEmail] = useState("");
  // `?confirmed=1` is derived during render (no effect) so no cascading render.
  const [status, setStatus] = useState<Status>(
    confirmedParam
      ? { kind: "ok", message: "Your email is verified. You can use all features." }
      : { kind: "checking", message: "" }
  );
  const [resendPending, setResendPending] = useState(false);

  // If the confirmation link already signed the user in (or they are
  // verified), say so instead of asking for the link again.
  useEffect(() => {
    if (confirmedParam) return;
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase.auth.getUser();
        if (cancelled) return;
        if (data.user && data.user.email_confirmed_at) {
          setStatus({ kind: "ok", message: "Your email is verified. You can use all features." });
        } else {
          setStatus({ kind: "idle", message: "" });
        }
      } catch {
        if (!cancelled) setStatus({ kind: "idle", message: "" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [confirmedParam]);

  async function onResend(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setStatus({ kind: "error", message: "Enter a valid email address." });
      return;
    }
    setResendPending(true);
    try {
      let supabase;
      try {
        supabase = createClient();
      } catch {
        setStatus({ kind: "error", message: "Verification mail is not configured yet. Contact support." });
        return;
      }
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: trimmed.toLowerCase(),
        options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/dashboard` },
      });
      setStatus(
        error
          ? { kind: "error", message: error.message || "Could not resend the link." }
          : { kind: "ok", message: "Verification link sent. Check your inbox." }
      );
    } catch {
      setStatus({ kind: "error", message: "Network error. Please try again." });
    } finally {
      setResendPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {status.kind === "checking" ? <LoadingState label="Checking verification…" /> : null}
      {status.kind === "ok" || status.kind === "error" ? (
        <p
          role={status.kind === "ok" ? "status" : "alert"}
          className={
            status.kind === "ok"
              ? "rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800"
              : "rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700"
          }
        >
          {status.message}
        </p>
      ) : null}
      {status.kind === "ok" ? (
        <p className="text-center text-sm">
          <a href="/dashboard" className="font-medium text-brand-700 hover:text-brand-800">
            Go to dashboard
          </a>
        </p>
      ) : (
        <form onSubmit={onResend} className="flex flex-col gap-4" noValidate>
          <Field label="Email" hint="Need a new link? Enter your email to resend it." required>
            <Input
              type="email"
              required
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Button type="submit" loading={resendPending} variant="outline" className="w-full">
            {resendPending ? "Sending…" : "Resend verification link"}
          </Button>
        </form>
      )}
      <p className="text-center text-sm">
        <a href="/login" className="font-medium text-brand-700 hover:text-brand-800">
          Back to login
        </a>
      </p>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <AuthLayout
      title="Verify email"
      subtitle="Confirm your address to unlock all features."
      footer={
        <>
          Already verified?{" "}
          <a href="/login" className="font-medium text-brand-700 hover:text-brand-800">
            Log in
          </a>
        </>
      }
    >
      <Suspense fallback={<LoadingState label="Loading…" />}>
        <VerifyForm />
      </Suspense>
    </AuthLayout>
  );
}
