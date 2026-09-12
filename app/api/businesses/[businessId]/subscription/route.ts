import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { requireRole } from "@/src/lib/tenancy/policies";
import { validateSubscriptionPatch } from "@/src/lib/billing/catalog";
import { changeSubscription, getSubscriptionView } from "@/src/lib/billing/subscriptions";

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

/** Current subscription + plan limits + live usage. Any workspace member may read. */
export async function GET(_req: Request, { params }: Params) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const view = await getSubscriptionView(g.context);
    return NextResponse.json(view, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

/**
 * Change plan or status. OWNER-only: billing mutations are the most
 * sensitive workspace operation, so ADMIN/SALES receive 403. Limits are
 * re-derived server-side from the stored plan — request fields can only
 * name a catalog plan, never set a quota.
 */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    requireRole(g.context, "OWNER");
    const parsed = validateSubscriptionPatch(await readJsonBody(req));
    if (!parsed.ok || !parsed.value) {
      return NextResponse.json({ errors: parsed.errors }, { status: 422 });
    }
    const { view } = await changeSubscription(g.context, parsed.value);
    return NextResponse.json(view, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
