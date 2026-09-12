import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import {
  syncConnectionNotifications,
  syncFollowUpNotifications,
} from "@/src/lib/tenancy/notifications";

async function guard(businessId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const resolved = await resolveBusinessContext(user.id, businessId);
  if (!resolved.ok) {
    return { error: NextResponse.json({ error: "Access denied for this business." }, { status: 403 }) };
  }
  return { user, context: resolved.context };
}

type Params = { params: Promise<{ businessId: string }> };

/**
 * Regenerate derived notifications (follow-up due/overdue, Facebook
 * connection expiry). Idempotent — re-runs collapse via dedupe keys.
 * Requires notifications.read.
 */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    try {
      const { apiRateLimiter, API_RATE_LIMITS } = await import("@/src/lib/auth/rate-limit");
      const budget = API_RATE_LIMITS.notificationSync;
      const decision = apiRateLimiter.check(
        `notif-sync:${g.user.id}:${businessId}`,
        budget.limit,
        budget.windowMs
      );
      if (!decision.allowed) {
        return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
      }
    } catch {
      // Limiter failure must not block legitimate syncs.
    }
    const [followUps, connections] = await Promise.all([
      syncFollowUpNotifications(g.context.business.id),
      syncConnectionNotifications(g.context.business.id),
    ]);
    return NextResponse.json({ ok: true, followUps, connections }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
