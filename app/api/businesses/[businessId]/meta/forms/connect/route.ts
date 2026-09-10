import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { connectLeadForm } from "@/src/lib/integrations/meta/pages";

async function guard(businessId: string) {
  const store = await cookies();
  const user = await getSessionUser(store.get(SESSION_COOKIE_NAME)?.value);
  if (!user) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const resolved = await resolveBusinessContext(user.id, businessId);
  if (!resolved.ok) {
    return { error: NextResponse.json({ error: "Access denied for this business." }, { status: 403 }) };
  }
  return { user, context: resolved.context };
}

/**
 * Connect a lead form on the selected Page. Requires businesses.update
 * (OWNER/ADMIN). Replaces any previously connected form.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const metaFormId = typeof body?.["metaFormId"] === "string" ? body["metaFormId"].trim() : "";
    if (!metaFormId) {
      return NextResponse.json({ errors: { metaFormId: "A form id is required." } }, { status: 422 });
    }
    const form = await connectLeadForm(g.context, metaFormId);
    return NextResponse.json({ form }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
