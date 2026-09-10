/**
 * Supabase server client (Server Components, Server Actions, Route Handlers).
 *
 * Server-only: imports `next/headers` and the typed env accessor. Never
 * import this module (or its result) from Client Components — use
 * `src/lib/supabase/client.ts` there.
 *
 * Uses the publishable key only — no service-role/secret key exists in this
 * codebase. Cookie writes are wrapped in try/catch because Server Components
 * may only read cookies; session refresh for those paths is handled by the
 * proxy (`src/lib/supabase/middleware.ts`).
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "../env";

export async function createClient() {
  const url = env.supabaseUrl;
  const key = env.supabasePublishableKey;
  if (!url || !key) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in your environment."
    );
  }
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component (read-only cookies). The proxy
          // refreshes the Supabase session cookie on pass-through requests.
        }
      },
    },
  });
}
