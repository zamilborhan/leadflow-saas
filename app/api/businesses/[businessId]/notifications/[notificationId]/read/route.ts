import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { markNotificationAsRead } from "@/src/lib/tenancy/notifications";

async function guard(businessId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const resolved = await resolveBusinessContext(user.id, businessId);
  if (!resolved.ok) {
    return { error: NextResponse.json({ error: "Access denied for this business." }, { status: 403 }) };
  }
  return { user, context: resolved.context };
}

type Params = { params: Promise<{ businessId: string; notificationId: string }> };

/** Mark one of my notifications as read. Unknown/foreign ids → 404. */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { businessId, notificationId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const notification = await markNotificationAsRead(g.context, notificationId);
    if (!notification) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ notification }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
