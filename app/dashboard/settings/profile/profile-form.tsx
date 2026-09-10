"use client";

import { useEffect, useState } from "react";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Field, Input } from "@/src/components/ui/input";
import { useToast } from "@/src/components/ui/toast";

interface MeUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
}

/** Signed-in user's profile: display name + password change. */
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

  return (
    <form onSubmit={onSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            {me?.email}{" "}
            {me && !me.emailVerified ? (
              <>
                · <span className="font-semibold text-amber-700">unverified</span>{" "}
                <button type="button" onClick={onResend} className="font-semibold text-brand-700 hover:underline">
                  Resend link
                </button>
              </>
            ) : (
              <>· verified</>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
              Leave blank to keep the current password. Minimum 12 characters.
            </p>
            <div className="mt-3 flex flex-col gap-4">
              <Field label="Current password">
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••••••"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </Field>
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
  );
}
