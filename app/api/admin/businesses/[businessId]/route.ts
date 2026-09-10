import { NextResponse } from "next/server";
import { requireSuperAdmin, superAdminErrorResponse } from "@/src/lib/admin/guard";
import { getBusinessAdmin, setBusinessStatus } from "@/src/lib/admin/businesses";
import { readJsonBody } from "@/src/lib/auth/http";

type Params = { params: Promise<{ businessId: string }> };

/** Single workspace detail. Super-admin only. */
export async function GET(_req: Request, { params }: Params) {
  try {
    const g = await requireSuperAdmin();
    if ("response" in g) return g.response;
    const { businessId } = await params;
    const business = await getBusinessAdmin(businessId);
    if (!business) return NextResponse.json({ error: "Business not found." }, { status: 404 });
    return NextResponse.json({ business }, { status: 200 });
  } catch (err) {
    return superAdminErrorResponse(err);
  }
}

/**
 * Suspend / reactivate a workspace. Body: { status: "ACTIVE" | "SUSPENDED" }.
 * Super-admin only — no workspace membership required.
 */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const g = await requireSuperAdmin();
    if ("response" in g) return g.response;
    const { businessId } = await params;
    const body = await readJsonBody(req);
    const status = (body as Record<string, unknown> | null)?.["status"];
    if (status !== "ACTIVE" && status !== "SUSPENDED") {
      return NextResponse.json(
        { errors: { status: 'Status must be "ACTIVE" or "SUSPENDED".' } },
        { status: 422 }
      );
    }
    const business = await setBusinessStatus(businessId, status);
    if (!business) return NextResponse.json({ error: "Business not found." }, { status: 404 });
    return NextResponse.json({ business }, { status: 200 });
  } catch (err) {
    return superAdminErrorResponse(err);
  }
}
