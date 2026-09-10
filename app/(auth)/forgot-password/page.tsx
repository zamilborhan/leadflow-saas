"use client";

import { useState } from "react";
import { AuthLayout } from "@/src/components/layout/auth-layout";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json()) as { message?: string; error?: string; errors?: Record<string, string> };
      if (!res.ok) {
        setError(data.error ?? (data.errors ? Object.values(data.errors).join(" ") : "Request failed."));
        return;
      }
      setDone(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Forgot password"
      subtitle="We'll email you a single-use reset link (expires in 1 hour)."
      footer={
        <>
          Remembered it?{" "}
          <a href="/login" className="font-medium text-brand-700 hover:text-brand-800">
            Log in
          </a>
        </>
      }
    >
      {done ? (
        <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800">
          If an account exists for this email, a password reset link has been sent.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Email" required>
            <Input
              type="email"
              required
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          {error ? (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {error}
            </p>
          ) : null}
          <Button type="submit" loading={pending} className="w-full">
            {pending ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
