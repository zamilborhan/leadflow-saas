import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { getBusinessForMember } from "@/src/lib/tenancy/businesses";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const { businessId } = await params;
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    // Membership-verified fetch: non-members and missing ids are identical.
    const business = await getBusinessForMember(user.id, businessId);
    if (!business) {
      return NextResponse.json({ error: "Access denied for this business." }, { status: 403 });
    }
    return NextResponse.json({ business }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
