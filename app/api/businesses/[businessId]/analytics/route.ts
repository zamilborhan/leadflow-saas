import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { getBusinessAnalytics } from "@/src/lib/tenancy/analytics";
import { validateAnalyticsQuery } from "@/src/lib/tenancy/validation";

async function guard(businessId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const resolved = await resolveBusinessContext(user.id, businessId);
  if (!resolved.ok) {
    return { error: NextResponse.json({ error: "Access denied for this business." }, { status: 403 }) };
  }
  return { user, context: resolved.context };
}

type Params = { params: Promise<{ businessId: string }> };

/** Tenant-scoped analytics payload. Requires leads.read. Filters: days/from/to/campaign/adSet/ad. */
export async function GET(req: Request, { params }: Params) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const url = new URL(req.url);
    const raw: Record<string, string | string[] | undefined> = {};
    url.searchParams.forEach((value, key) => {
      const prev = raw[key];
      raw[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
    });
    const analytics = await getBusinessAnalytics(g.context, validateAnalyticsQuery(raw));
    return NextResponse.json({ analytics }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
