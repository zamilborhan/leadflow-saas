import { NextResponse } from "next/server";
import { requireSuperAdmin, superAdminErrorResponse } from "@/src/lib/admin/guard";
import { listPaymentsAdmin } from "@/src/lib/admin/payments";

/** Platform payment history, optionally scoped to one workspace. Super-admin only. */
export async function GET(req: Request) {
  try {
    const g = await requireSuperAdmin();
    if ("response" in g) return g.response;
    const url = new URL(req.url);
    const result = await listPaymentsAdmin({
      businessId: url.searchParams.get("businessId") ?? undefined,
      page: url.searchParams.has("page") ? Number(url.searchParams.get("page")) : undefined,
      pageSize: url.searchParams.has("pageSize") ? Number(url.searchParams.get("pageSize")) : undefined,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return superAdminErrorResponse(err);
  }
}
