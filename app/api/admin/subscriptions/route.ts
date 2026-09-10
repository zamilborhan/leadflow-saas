import { NextResponse } from "next/server";
import { requireSuperAdmin, superAdminErrorResponse } from "@/src/lib/admin/guard";
import { listSubscriptionsAdmin } from "@/src/lib/admin/subscriptions";

/** Platform subscription directory. Super-admin only. */
export async function GET(req: Request) {
  try {
    const g = await requireSuperAdmin();
    if ("response" in g) return g.response;
    const url = new URL(req.url);
    const result = await listSubscriptionsAdmin({
      search: url.searchParams.get("search") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      planCode: url.searchParams.get("planCode") ?? undefined,
      page: url.searchParams.has("page") ? Number(url.searchParams.get("page")) : undefined,
      pageSize: url.searchParams.has("pageSize") ? Number(url.searchParams.get("pageSize")) : undefined,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return superAdminErrorResponse(err);
  }
}
