"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthLayout } from "@/src/components/layout/auth-layout";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { LoadingState } from "@/src/components/ui/states";

function VerifyForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "error"; message: string }>({
    kind: "idle",
    message: "",
  });
  const [resendPending, setResendPending] = useState(false);

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/verify-email/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = (await res.json()) as { message?: string; error?: string };
        if (!cancelled) {
          setStatus(
            res.ok
              ? { kind: "ok", message: data.message ?? "Email verified." }
              : { kind: "error", message: data.error ?? "Verification failed." }
          );
        }
      } catch {
        if (!cancelled) setStatus({ kind: "error", message: "Network error. Please try again." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  async function onResend(e: React.FormEvent) {
    e.preventDefault();
    setResendPending(true);
    try {
      const res = await fetch("/api/auth/verify-email/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json()) as { message?: string; error?: string; errors?: Record<string, string> };
      setStatus(
        res.ok
          ? { kind: "ok", message: data.message ?? "Verification link sent." }
          : { kind: "error", message: data.error ?? "Request failed." }
      );
    } catch {
      setStatus({ kind: "error", message: "Network error. Please try again." });
    } finally {
      setResendPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {status.kind !== "idle" ? (
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
      <form onSubmit={onResend} className="flex flex-col gap-4">
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
      <p className="text-center text-sm">
        <a href="/dashboard" className="font-medium text-brand-700 hover:text-brand-800">
          Go to dashboard
        </a>
      </p>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <AuthLayout
      title="Verify email"
      subtitle="Links expire after 24 hours and are single-use."
      footer={
        <>
          Remembered your password?{" "}
          <a href="/login" className="font-medium text-brand-700 hover:text-brand-800">
            Log in
          </a>
        </>
      }
    >
      <Suspense fallback={<LoadingState label="Verifying…" />}>
        <VerifyForm />
      </Suspense>
    </AuthLayout>
  );
}
