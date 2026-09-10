import { NextResponse } from "next/server";
import { requireSuperAdmin, superAdminErrorResponse } from "@/src/lib/admin/guard";
import { listPlans } from "@/src/lib/billing/plans";

/** Plan catalog (seeded rows + static pricing). Super-admin only. */
export async function GET() {
  try {
    const g = await requireSuperAdmin();
    if ("response" in g) return g.response;
    const plans = await listPlans();
    return NextResponse.json({ plans }, { status: 200 });
  } catch (err) {
    return superAdminErrorResponse(err);
  }
}
