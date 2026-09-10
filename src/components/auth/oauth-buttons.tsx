"use client";

import { useState } from "react";
import { Button } from "@/src/components/ui/button";
import { createClient } from "@/src/lib/supabase/client";

type OAuthProvider = "google" | "facebook";

const PROVIDER_NAME: Record<OAuthProvider, string> = {
  google: "Google",
  facebook: "Facebook",
};

function friendlyOAuthError(provider: OAuthProvider, message: string): string {
  const name = PROVIDER_NAME[provider];
  if (/access_denied|cancelled/i.test(message)) {
    return `${name} sign-in was cancelled. Try again or use email.`;
  }
  return message || `${name} sign-in failed. Try again or use email.`;
}

function ProviderIcon({ provider }: { provider: OAuthProvider }) {
  if (provider === "facebook") {
    return (
      <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="#1877F2">
        <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.8-4.7 4.54-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.95.93-1.95 1.89v2.26h3.32l-.53 3.49h-2.79V24C19.61 23.09 24 18.1 24 12.07z" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0012 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1a6.6 6.6 0 010-4.2V7.06H2.18a11 11 0 000 9.88l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 002.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

/**
 * Shared Supabase OAuth button (login and registration use the same flow:
 * Supabase signs in existing provider accounts and creates new ones — never
 * duplicates, never a provider password in our code).
 *
 * Starts the redirect flow; Supabase returns the browser to
 * `/auth/callback?next=…`, which exchanges the code for a session and routes
 * to the dashboard or workspace creation. `redirectTo` derives from the
 * current origin, so no localhost is hardcoded for production.
 */
function OAuthButton({
  provider,
  label,
  next = "/dashboard",
  disabled,
  onError,
  onPendingChange,
}: {
  provider: OAuthProvider;
  label: string;
  next?: string;
  /** Disabled while another auth flow (e.g. email submit) is processing. */
  disabled?: boolean;
  onError?: (message: string) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [pending, setPending] = useState(false);

  function setBusy(value: boolean) {
    setPending(value);
    onPendingChange?.(value);
  }

  async function onClick() {
    onError?.("");
    setBusy(true);
    try {
      let supabase;
      try {
        supabase = createClient();
      } catch {
        onError?.(`${PROVIDER_NAME[provider]} sign-in is not configured yet. Contact support.`);
        setBusy(false);
        return;
      }
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          // Facebook accounts without a confirmed email (or declined email
          // permission) must still identify the user — request it explicitly.
          ...(provider === "facebook" ? { scopes: "email public_profile" } : {}),
          // Navigate explicitly so failures stay on this page with an error
          // instead of relying on the library's automatic redirect.
          skipBrowserRedirect: true,
        },
      });
      if (error || !data.url) {
        onError?.(friendlyOAuthError(provider, error?.message ?? ""));
        setBusy(false);
        return;
      }
      window.location.assign(data.url);
    } catch {
      onError?.("Network error. Please try again.");
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      loading={pending}
      disabled={disabled}
      onClick={onClick}
      className="w-full"
    >
      <ProviderIcon provider={provider} />
      {pending ? `Connecting to ${PROVIDER_NAME[provider]}…` : label}
    </Button>
  );
}

export function GoogleOAuthButton({
  next = "/dashboard",
  disabled,
  onError,
  onPendingChange,
}: {
  next?: string;
  disabled?: boolean;
  onError?: (message: string) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  return (
    <OAuthButton
      provider="google"
      label="Continue with Google"
      next={next}
      disabled={disabled}
      onError={onError}
      onPendingChange={onPendingChange}
    />
  );
}

export function FacebookOAuthButton({
  next = "/dashboard",
  disabled,
  onError,
  onPendingChange,
}: {
  next?: string;
  disabled?: boolean;
  onError?: (message: string) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  return (
    <OAuthButton
      provider="facebook"
      label="Continue with Facebook"
      next={next}
      disabled={disabled}
      onError={onError}
      onPendingChange={onPendingChange}
    />
  );
}

/** "OR" separator between social buttons and the email form. */
export function AuthDivider() {
  return (
    <div aria-hidden="true" className="flex items-center gap-3 text-xs font-medium text-slate-400">
      <span className="h-px flex-1 bg-slate-200" />
      OR
      <span className="h-px flex-1 bg-slate-200" />
    </div>
  );
}
