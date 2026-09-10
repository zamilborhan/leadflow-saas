import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { env } from "@/src/lib/env";
import { handleMetaCallback, MetaOAuthError } from "@/src/lib/integrations/meta/service";
import { MetaApiError } from "@/src/lib/integrations/meta/client";

/**
 * Step 2 of Meta OAuth: Meta redirects here with `?code=&state=`.
 * Verifies state, performs the server-to-server code exchange, stores the
 * encrypted connection, then redirects into settings. Failure redirects
 * carry only a generic flag — never codes, tokens, or debug detail.
 */
export async function GET(req: Request) {
  const store = await cookies();
  const user = await getSessionUser(store.get(SESSION_COOKIE_NAME)?.value);
  const url = new URL(req.url);
  const fail = (businessId?: string) => {
    const next = new URL("/dashboard/settings", env.nextAuthUrl);
    if (businessId) next.searchParams.set("businessId", businessId);
    next.searchParams.set("meta", "error");
    return NextResponse.redirect(next);
  };
  if (!user) {
    return NextResponse.redirect(new URL("/login", env.nextAuthUrl));
  }
  try {
    const { businessId } = await handleMetaCallback({
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      sessionUserId: user.id,
      error: url.searchParams.get("error"),
      errorDescription: url.searchParams.get("error_description"),
    });
    const next = new URL("/dashboard/settings", env.nextAuthUrl);
    next.searchParams.set("businessId", businessId);
    next.searchParams.set("meta", "connected");
    return NextResponse.redirect(next);
  } catch (err) {
    if (err instanceof MetaOAuthError || err instanceof MetaApiError) {
      return fail();
    }
    return fail();
  }
}
