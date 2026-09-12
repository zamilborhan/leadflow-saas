import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { queryFollowUps } from "@/src/lib/tenancy/followups";
import { validateFollowUpQuery } from "@/src/lib/tenancy/validation";

async function guard(businessId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const resolved = await resolveBusinessContext(user.id, businessId);
  if (!resolved.ok) {
    return { error: NextResponse.json({ error: "Access denied for this business." }, { status: 403 }) };
  }
  return { user, context: resolved.context };
}

function queryOf(req: Request): Record<string, string | string[] | undefined> {
  const url = new URL(req.url);
  const raw: Record<string, string | string[] | undefined> = {};
  url.searchParams.forEach((value, key) => {
    const prev = raw[key];
    raw[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
  });
  return raw;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const raw = queryOf(req);
    // "me"/"mine" resolve to the caller for assignee/scope filtering.
    if (raw["assignee"] === "me") raw["assignee"] = g.user.id;
    if (raw["scope"] === "mine") {
      raw["scope"] = "all";
      raw["assignee"] = g.user.id;
    }
    const result = await queryFollowUps(g.context, validateFollowUpQuery(raw));
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
