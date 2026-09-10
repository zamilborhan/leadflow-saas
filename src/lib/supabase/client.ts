/**
 * Supabase browser client (Client Components only).
 *
 * Reads the public URL + publishable key directly from `process.env`:
 * `NEXT_PUBLIC_` values are inlined into the browser bundle by Next.js, so
 * this module must NOT import `src/lib/env.ts` (server-only rule). No secret
 * key is referenced anywhere — the publishable key is safe by design.
 *
 * `createBrowserClient` persists the session in cookies (singleton per
 * browser tab set), so server-rendered requests read the same session the
 * browser wrote. Throws a clear message when Supabase is unconfigured
 * instead of failing obscurely at request time.
 */
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in your environment."
    );
  }
  return createBrowserClient(url, key);
}
