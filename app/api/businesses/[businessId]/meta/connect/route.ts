import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { buildConnectUrl } from "@/src/lib/integrations/meta/service";

async function guard(businessId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const resolved = await resolveBusinessContext(user.id, businessId);
  if (!resolved.ok) {
    return { error: NextResponse.json({ error: "Access denied for this business." }, { status: 403 }) };
  }
  return { user, context: resolved.context };
}

/**
 * Step 1 of Meta OAuth: redirect an authorized workspace manager to the
 * Meta Login dialog. Requires businesses.update (OWNER/ADMIN) — connecting
 * a shared ad asset is a workspace-management action, not a sales action.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const url = await buildConnectUrl(g.context);
    return NextResponse.redirect(url);
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
