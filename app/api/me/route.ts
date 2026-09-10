import { cookies } from "next/headers";
import { meService } from "@/src/lib/auth/service";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { applyServiceResult, internalError } from "@/src/lib/auth/http";

export async function GET() {
  try {
    const store = await cookies();
    const result = await meService(store.get(SESSION_COOKIE_NAME)?.value);
    return applyServiceResult(result);
  } catch (err) {
    return internalError("me", err);
  }
}
