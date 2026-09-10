import { NextResponse } from "next/server";
import { requireSuperAdmin, superAdminErrorResponse } from "@/src/lib/admin/guard";
import { listBusinessesAdmin } from "@/src/lib/admin/businesses";

/** Platform business directory. Super-admin only. */
export async function GET(req: Request) {
  try {
    const g = await requireSuperAdmin();
    if ("response" in g) return g.response;
    const url = new URL(req.url);
    const page = {
      search: url.searchParams.get("search") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      page: url.searchParams.has("page") ? Number(url.searchParams.get("page")) : undefined,
      pageSize: url.searchParams.has("pageSize") ? Number(url.searchParams.get("pageSize")) : undefined,
    };
    const result = await listBusinessesAdmin(page);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return superAdminErrorResponse(err);
  }
}
