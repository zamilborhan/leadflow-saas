import { NextResponse } from "next/server";
import { requireSuperAdmin, superAdminErrorResponse } from "@/src/lib/admin/guard";
import { adminChangeSubscription, getBusinessAdmin, getBusinessUsageAdmin } from "@/src/lib/admin/businesses";
import { validateSubscriptionPatch } from "@/src/lib/billing/catalog";
import { readJsonBody } from "@/src/lib/auth/http";

type Params = { params: Promise<{ businessId: string }> };

/** Workspace subscription + usage snapshot. Super-admin only. */
export async function GET(_req: Request, { params }: Params) {
  try {
    const g = await requireSuperAdmin();
    if ("response" in g) return g.response;
    const { businessId } = await params;
    const business = await getBusinessAdmin(businessId);
    if (!business) return NextResponse.json({ error: "Business not found." }, { status: 404 });
    const usage = await getBusinessUsageAdmin(businessId);
    return NextResponse.json({ business, usage }, { status: 200 });
  } catch (err) {
    return superAdminErrorResponse(err);
  }
}

/**
 * Change plan or subscription status for a workspace.
 * Body: { planCode?: PlanCode, status?: "ACTIVE"|"PAST_DUE"|"CANCELED" }.
 * Super-admin only.
 */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const g = await requireSuperAdmin();
    if ("response" in g) return g.response;
    const { businessId } = await params;
    const parsed = validateSubscriptionPatch(await readJsonBody(req));
    if (!parsed.ok || !parsed.value) {
      return NextResponse.json({ errors: parsed.errors }, { status: 422 });
    }
    const result = await adminChangeSubscription(businessId, parsed.value);
    if (!result) return NextResponse.json({ error: "Business not found." }, { status: 404 });
    return NextResponse.json({ subscription: result }, { status: 200 });
  } catch (err) {
    return superAdminErrorResponse(err);
  }
}
