import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { meService, updateProfileService } from "@/src/lib/auth/service";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { applyServiceResult, internalError, isAllowedRequestOrigin, readJsonBody } from "@/src/lib/auth/http";
import { env } from "@/src/lib/env";

export async function GET() {
  try {
    const store = await cookies();
    const result = await meService(store.get(SESSION_COOKIE_NAME)?.value);
    return applyServiceResult(result);
  } catch (err) {
    return internalError("me", err);
  }
}

export async function PATCH(req: Request) {
  try {
    if (!isAllowedRequestOrigin(req, env.appUrl)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const store = await cookies();
    const result = await updateProfileService(
      store.get(SESSION_COOKIE_NAME)?.value,
      await readJsonBody(req)
    );
    return applyServiceResult(result);
  } catch (err) {
    return internalError("me-update", err);
  }
}
