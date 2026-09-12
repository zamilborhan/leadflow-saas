import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { selectMetaPage } from "@/src/lib/integrations/meta/pages";

async function guard(businessId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const resolved = await resolveBusinessContext(user.id, businessId);
  if (!resolved.ok) {
    return { error: NextResponse.json({ error: "Access denied for this business." }, { status: 403 }) };
  }
  return { user, context: resolved.context };
}

/** Select the workspace Page. Requires businesses.update (OWNER/ADMIN). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const metaPageId = typeof body?.["metaPageId"] === "string" ? body["metaPageId"].trim() : "";
    if (!metaPageId) {
      return NextResponse.json({ errors: { metaPageId: "A Page id is required." } }, { status: 422 });
    }
    const page = await selectMetaPage(g.context, metaPageId);
    return NextResponse.json({ page }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
