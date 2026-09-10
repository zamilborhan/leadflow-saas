import { cookies } from "next/headers";
import { logoutService } from "@/src/lib/auth/service";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { applyServiceResult, internalError } from "@/src/lib/auth/http";

export async function POST() {
  try {
    const store = await cookies();
    const result = await logoutService(store.get(SESSION_COOKIE_NAME)?.value);
    return applyServiceResult(result);
  } catch (err) {
    return internalError("logout", err);
  }
}
