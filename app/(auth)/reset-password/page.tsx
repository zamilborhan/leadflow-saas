"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthLayout } from "@/src/components/layout/auth-layout";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { LoadingState } from "@/src/components/ui/states";

function ResetForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [token, setToken] = useState(searchParams.get("token") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.trim(), password }),
      });
      const data = (await res.json()) as { message?: string; error?: string; errors?: Record<string, string> };
      if (!res.ok) {
        setError(data.error ?? (data.errors ? Object.values(data.errors).join(" ") : "Reset failed."));
        return;
      }
      setDone(true);
      setTimeout(() => router.push("/login"), 2000);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800">
        Password has been reset. Redirecting to login…
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="Reset token" hint="Paste from your email if the link didn't fill it in." required>
        <Input
          type="text"
          required
          autoComplete="off"
          placeholder="Reset token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>
      <Field label="New password" hint="Minimum 12 characters." required>
        <Input
          type="password"
          required
          autoComplete="new-password"
          minLength={12}
          placeholder="Choose a strong password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
      <Button type="submit" loading={pending} className="w-full">
        {pending ? "Resetting…" : "Reset password"}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthLayout
      title="Reset password"
      subtitle="Choose a new password (minimum 12 characters)."
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
