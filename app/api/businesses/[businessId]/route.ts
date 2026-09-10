import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { getBusinessForMember } from "@/src/lib/tenancy/businesses";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const { businessId } = await params;
    const store = await cookies();
    const user = await getSessionUser(store.get(SESSION_COOKIE_NAME)?.value);
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
