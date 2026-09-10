import { NextResponse } from "next/server";
import { requireSuperAdmin, superAdminErrorResponse } from "@/src/lib/admin/guard";
import { getPlatformOverview } from "@/src/lib/admin/overview";

/** Platform metrics snapshot. Super-admin only. */
export async function GET() {
  try {
    const g = await requireSuperAdmin();
    if ("response" in g) return g.response;
    const overview = await getPlatformOverview();
    return NextResponse.json({ overview }, { status: 200 });
  } catch (err) {
    return superAdminErrorResponse(err);
  }
}
