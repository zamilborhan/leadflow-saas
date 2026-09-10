/**
 * Supabase session refresh for the Next.js proxy (`proxy.ts`).
 *
 * Calls `supabase.auth.getUser()` on every pass-through request so an
 * expiring Supabase session is refreshed and the updated auth cookies land
 * on the response before any page or API route runs.
 *
 * Coexistence contract with the existing LeadFlow session system:
 * - This helper makes NO routing decisions. All redirects stay in `proxy.ts`
 *   and are still driven solely by the `lf_session` cookie.
 * - When Supabase is unconfigured (no URL/publishable key), this is a pure
 *   pass-through: no network calls, no behavior change, existing tests stay
 *   green without Supabase credentials.
 * - Must stay Edge-safe: no Node-only imports (no `node:crypto`, no
 *   `next/headers` — only the request/response cookie stores).
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "../env";

/** True when both public Supabase vars are present. */
export function isSupabaseConfigured(): boolean {
  return env.isSupabaseConfigured;
}

/**
 * Refresh the Supabase session for `request`.
 *
 * Returns the response that carries any updated auth cookies plus the
 * Supabase user (`{ id, email } | null`) so the proxy can treat a valid
 * Supabase session as signed-in without a second auth call. Drop-in
 * replacement for `NextResponse.next()` on pass-through paths.
 */
export async function updateSupabaseSession(request: NextRequest): Promise<{
  response: NextResponse;
  user: { id: string; email: string } | null;
}> {
  const response = NextResponse.next({ request });

  const url = env.supabaseUrl;
  const key = env.supabasePublishableKey;
  if (!url || !key) return { response, user: null };

  let liveResponse = response;
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        liveResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          liveResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // Authenticated call: validates the session and refreshes it when the
  // access token is expiring. Missing/invalid sessions resolve locally to
  // null without a network call.
  const { data, error } = await supabase.auth.getUser();
  const u = error ? null : data.user;
  return {
    response: liveResponse,
    user: u && u.email ? { id: u.id, email: u.email } : null,
  };
}
