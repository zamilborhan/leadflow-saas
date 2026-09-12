import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { logoutService } from "@/src/lib/auth/service";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { applyServiceResult, internalError, isAllowedRequestOrigin } from "@/src/lib/auth/http";
import { env } from "@/src/lib/env";

export async function POST(req: Request) {
  try {
    if (!isAllowedRequestOrigin(req, env.appUrl)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const store = await cookies();
    const result = await logoutService(store.get(SESSION_COOKIE_NAME)?.value);
    return applyServiceResult(result);
  } catch (err) {
    return internalError("logout", err);
  }
}
