"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AuthLayout } from "@/src/components/layout/auth-layout";
import { OAuthButtons } from "@/src/components/auth/oauth-buttons";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name || undefined, email, password }),
      });
      const data = (await res.json()) as {
        error?: string;
        errors?: Record<string, string>;
        businessId?: string;
      };
      if (!res.ok) {
        setError(
          data.error ??
            (data.errors ? Object.values(data.errors).join(" ") : "Registration failed.")
        );
        return;
      }
      router.push(data.businessId ? `/dashboard?businessId=${data.businessId}` : "/dashboard");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Start your 14-day free trial. A workspace is created automatically."
      footer={
        <>
          Have an account?{" "}
          <a href="/login" className="font-medium text-brand-700 hover:text-brand-800">
            Log in
          </a>
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <OAuthButtons mode="register" />
        <div aria-hidden="true" className="flex items-center gap-3 text-xs text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />
          or with email
          <span className="h-px flex-1 bg-slate-200" />
        </div>
        <Field label="Name" hint="Optional — shown to your teammates.">
          <Input
            type="text"
            autoComplete="name"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Work email" required>
          <Input
            type="email"
            required
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password" hint="Minimum 12 characters." required>
          <Input
            type="password"
            required
            autoComplete="new-password"
            minLength={12}
            placeholder="Create a strong password"
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
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthLayout>
  );
}
