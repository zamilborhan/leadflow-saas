"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/src/components/ui/button";

/**
 * Signs out of every session this app knows about:
 * - Supabase (browser session + cookies), when configured. The client is
 *   imported lazily so routes that never log out never load `supabase-js`.
 * - The legacy database session (`lf_session`) via the idempotent logout
 *   endpoint, which also clears the cookie.
 */
export async function signOutEverywhere(): Promise<void> {
  try {
    const { createClient } = await import("@/src/lib/supabase/client");
    await createClient().auth.signOut();
  } catch {
    // Supabase unconfigured or already signed out — legacy logout below
    // still runs.
  }
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Network failure must not trap the user; navigation still clears views.
  }
}

/** Reusable logout button: signs out everywhere, then lands on login. */
export function LogoutButton({
  redirectTo = "/login",
  variant = "outline",
  className,
  children = "Log out",
}: {
  redirectTo?: string;
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger";
  className?: string;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      await signOutEverywhere();
    } finally {
      router.push(redirectTo);
      router.refresh();
    }
  }

  return (
    <Button type="button" variant={variant} loading={pending} onClick={onClick} className={className}>
      {children}
    </Button>
  );
}
