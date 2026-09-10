import { NextResponse } from "next/server";
import { requireSuperAdmin, superAdminErrorResponse } from "@/src/lib/admin/guard";
import { getUserAdmin } from "@/src/lib/admin/users";

type Params = { params: Promise<{ userId: string }> };

/** Single platform user with workspace memberships. Super-admin only. */
export async function GET(_req: Request, { params }: Params) {
  try {
    const g = await requireSuperAdmin();
    if ("response" in g) return g.response;
    const { userId } = await params;
    const user = await getUserAdmin(userId);
    if (!user) return NextResponse.json({ error: "User not found." }, { status: 404 });
    return NextResponse.json({ user }, { status: 200 });
  } catch (err) {
    return superAdminErrorResponse(err);
  }
}
