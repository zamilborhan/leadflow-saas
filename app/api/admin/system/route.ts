import { NextResponse } from "next/server";
import { requireSuperAdmin, superAdminErrorResponse } from "@/src/lib/admin/guard";
import { getSystemHealth } from "@/src/lib/admin/system";

/** Platform system health (liveness probes only, no secrets). Super-admin only. */
export async function GET() {
  try {
    const g = await requireSuperAdmin();
    if ("response" in g) return g.response;
    const health = await getSystemHealth();
    return NextResponse.json({ health }, { status: 200 });
  } catch (err) {
    return superAdminErrorResponse(err);
  }
}
