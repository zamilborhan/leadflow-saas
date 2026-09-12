"use client";

import { useEffect, useState } from "react";
import { LogoutButton } from "@/src/components/auth/logout-button";
import { AccountAvatar } from "@/src/components/layout/header";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Field, Input } from "@/src/components/ui/input";
import { useToast } from "@/src/components/ui/toast";

interface MeUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
  authProvider: string | null;
}

function providerLabel(provider: string | null): string {
  if (provider === "google") return "Google";
  if (provider === "facebook") return "Facebook";
  return "Email";
}

/** Signed-in user's profile: identity, display name, password, sign-out. */
export function ProfileForm() {
  const toast = useToast();
  const [me, setMe] = useState<MeUser | null>(null);
  const [name, setName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me");
        const data = (await res.json()) as { user?: MeUser };
        if (!cancelled && res.ok && data.user) {
          setMe(data.user);
          setName(data.user.name ?? "");
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onResend() {
    if (!me) return;
    const res = await fetch("/api/auth/verify-email/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: me.email }),
    });
    toast(
      res.ok
        ? { title: "Verification sent", description: "Check your inbox for the link.", variant: "success" }
        : { title: "Could not send", description: "Please try again later.", variant: "error" }
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const body: Record<string, unknown> = {};
      if (name.trim() !== (me?.name ?? "")) body.name = name.trim() === "" ? null : name.trim();
      if (newPassword) {
        body.newPassword = newPassword;
        body.currentPassword = currentPassword;
      }
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { user?: MeUser; error?: string; errors?: Record<string, string> };
      if (!res.ok || !data.user) {
        setError(data.error ?? (data.errors ? Object.values(data.errors).join(" ") : "Update failed."));
        return;
      }
      setMe(data.user);
      setName(data.user.name ?? "");
      setCurrentPassword("");
      setNewPassword("");
      toast({ title: "Profile updated", variant: "success" });
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (!loaded) return <p className="text-sm text-slate-500">Loading profile…</p>;

  const provider = providerLabel(me?.authProvider ?? null);
  const isSocial = me?.authProvider === "google" || me?.authProvider === "facebook";

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <CardContent>
          <div className="flex items-center gap-4">
            <AccountAvatar email={me?.email ?? "?"} avatarUrl={me?.avatarUrl} size="lg" />
            <div className="min-w-0">
              <p className="truncate text-lg font-bold text-slate-900">
                {me?.name || me?.email || "Your profile"}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Badge variant="neutral">Signed in with {provider}</Badge>
                {me && (me.emailVerified ? (
                  <Badge variant="success" dot>Verified</Badge>
                ) : (
                  <Badge variant="warning" dot>Unverified</Badge>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <form onSubmit={onSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>How you appear to your team.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field
              label="Email"
              hint="Your sign-in address. It can't be changed here — email changes must go through verification."
            >
              <Input type="email" value={me?.email ?? ""} disabled readOnly />
            </Field>
            {!me?.emailVerified ? (
              <p className="text-sm text-slate-500">
                Your email is unverified.{" "}
                <button type="button" onClick={onResend} className="font-semibold text-brand-700 hover:underline">
                  Resend verification link
                </button>
              </p>
            ) : null}
            <Field label="Display name" hint="Shown to your teammates. Clear to remove.">
              <Input
                type="text"
                autoComplete="name"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div className="border-t border-slate-100 pt-4">
              <p className="text-sm font-semibold text-slate-900">Change password</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {isSocial
                  ? `Signed in with ${provider} — no current password needed. Minimum 12 characters.`
                  : "Leave blank to keep the current password. Minimum 12 characters."}
              </p>
              <div className="mt-3 flex flex-col gap-4">
                {!isSocial ? (
                  <Field label="Current password">
                    <Input
                      type="password"
                      autoComplete="current-password"
                      placeholder="••••••••••••"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                    />
                  </Field>
                ) : null}
                <Field label="New password">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    minLength={newPassword ? 12 : undefined}
                    placeholder="Choose a strong password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </Field>
              </div>
            </div>
            {error ? (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                {error}
              </p>
            ) : null}
          </CardContent>
          <CardFooter>
            <Button type="submit" loading={pending}>
              Save changes
            </Button>
          </CardFooter>
        </Card>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>Sign out</CardTitle>
          <CardDescription>Ends your session on this device.</CardDescription>
        </CardHeader>
        <CardContent>
          <LogoutButton variant="outline" redirectTo="/login">
            Log out
          </LogoutButton>
        </CardContent>
      </Card>
    </div>
  );
}
