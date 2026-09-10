import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { requirePermission } from "@/src/lib/tenancy/policies";
import { drainDueAutomationJobs } from "@/src/lib/automation/jobs";

async function guard(businessId: string) {
  const store = await cookies();
  const user = await getSessionUser(store.get(SESSION_COOKIE_NAME)?.value);
  if (!user) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const resolved = await resolveBusinessContext(user.id, businessId);
  if (!resolved.ok) {
    return { error: NextResponse.json({ error: "Access denied for this business." }, { status: 403 }) };
  }
  return { user, context: resolved.context };
}

type Params = { params: Promise<{ businessId: string }> };

/**
 * Execute due automation jobs now (manual drain / cron target).
 * Requires automations.manage.
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
    const summary = await drainDueAutomationJobs(g.context.business.id, { limit: 50 });
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
