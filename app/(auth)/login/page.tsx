"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthLayout } from "@/src/components/layout/auth-layout";
import { OAuthButtons } from "@/src/components/auth/oauth-buttons";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { LoadingState } from "@/src/components/ui/states";

const OAUTH_ERRORS: Record<string, string> = {
  oauth_cancelled: "Social sign-in was cancelled. Try again or use email.",
  oauth_invalid_state: "Social sign-in expired. Please try again.",
  oauth_failed: "Social sign-in failed. Try again or use email.",
  provider_not_configured: "Social sign-in is not configured yet. Use email for now.",
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const oauthError = OAUTH_ERRORS[searchParams.get("error") ?? ""] ?? null;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json()) as { error?: string; errors?: Record<string, string> };
      if (!res.ok) {
        setError(
          data.error ??
            (data.errors ? Object.values(data.errors).join(" ") : "Login failed.")
        );
        return;
      }
      router.push(searchParams.get("next") ?? "/dashboard");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Log in to your LeadFlow workspace."
      footer={
        <>
          No account?{" "}
          <a href="/register" className="font-medium text-brand-700 hover:text-brand-800">
            Create one
          </a>
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate={false}>
        <OAuthButtons mode="login" />
        <div aria-hidden="true" className="flex items-center gap-3 text-xs text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />
          or with email
          <span className="h-px flex-1 bg-slate-200" />
        </div>
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
        <Field label="Password" required>
          <Input
            type="password"
            required
            autoComplete="current-password"
            placeholder="••••••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error || oauthError ? (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
            {error ?? oauthError}
          </p>
        ) : null}
        <Button type="submit" loading={pending} className="w-full">
          {pending ? "Logging in…" : "Log in"}
        </Button>
        <p className="text-center text-sm">
          <a href="/forgot-password" className="font-medium text-brand-700 hover:text-brand-800">
            Forgot password?
          </a>
        </p>
      </form>
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
