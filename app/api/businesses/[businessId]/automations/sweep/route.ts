import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { requirePermission } from "@/src/lib/tenancy/policies";
import { sweepNoContactLeads } from "@/src/lib/automation/jobs";

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
 * Run the NO_CONTACT_AFTER_TIME sweeper now (manual / cron target): scan
 * silent leads, enqueue one job per enabled rule (daily idempotency), and
 * drain. Requires automations.manage.
 */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    try {
      requirePermission(g.context, "automations.manage");
    } catch (err) {
      return tenancyErrorResponse(err);
    }
    try {
      const { apiRateLimiter, API_RATE_LIMITS } = await import("@/src/lib/auth/rate-limit");
      const budget = API_RATE_LIMITS.automationExpensive;
      const decision = apiRateLimiter.check(
        `sweep:${g.user.id}:${businessId}`,
        budget.limit,
        budget.windowMs
      );
      if (!decision.allowed) {
        return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
      }
    } catch {
      // Limiter failure must not block legitimate sweeps.
    }
    const summary = await sweepNoContactLeads(g.context.business.id);
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
