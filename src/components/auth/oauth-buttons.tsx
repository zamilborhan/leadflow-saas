"use client";

import { ButtonLink } from "@/src/components/ui/button";

/** Social sign-in links (full navigation: the authorize route 302s to the provider). */
export function OAuthButtons({ mode }: { mode: "login" | "register" }) {
  const label = mode === "login" ? "Continue with" : "Sign up with";
  return (
    <div className="flex flex-col gap-2.5">
      <ButtonLink
        variant="outline"
        className="w-full"
        href="/api/auth/oauth/google"
      >
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
        {label} Google
      </ButtonLink>
      <ButtonLink
        variant="outline"
        className="w-full"
        href="/api/auth/oauth/facebook"
      >
        <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="#1877F2">
          <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.8-4.7 4.54-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.95.93-1.95 1.89v2.26h3.32l-.53 3.49h-2.79V24C19.61 23.09 24 18.1 24 12.07z" />
        </svg>
        {label} Facebook
      </ButtonLink>
    </div>
  );
}
