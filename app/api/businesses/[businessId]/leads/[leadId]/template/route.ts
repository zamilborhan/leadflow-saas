import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import {
  clearLeadTemplateSelection,
  getLeadTemplateSelection,
  selectTemplateForLead,
} from "@/src/lib/integrations/whatsapp/templates";

async function guard(businessId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const resolved = await resolveBusinessContext(user.id, businessId);
  if (!resolved.ok) {
    return { error: NextResponse.json({ error: "Access denied for this business." }, { status: 403 }) };
  }
  return { user, context: resolved.context };
}

type Params = { params: Promise<{ businessId: string; leadId: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { businessId, leadId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const selection = await getLeadTemplateSelection(g.context, leadId);
    if (!selection) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ selection }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

/**
 * Select an APPROVED template for a lead. Requires leads.update (SALES
 * included). Unknown templates → 404; non-APPROVED → 409.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { businessId, leadId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const name = typeof body?.["name"] === "string" ? body["name"].trim() : "";
    const language = typeof body?.["language"] === "string" ? body["language"].trim() : "";
    const errors: Record<string, string> = {};
    if (!name) errors["name"] = "A template name is required.";
    if (!language) errors["language"] = "A template language is required.";
    if (Object.keys(errors).length > 0) {
      return NextResponse.json({ errors }, { status: 422 });
    }
    const selection = await selectTemplateForLead(g.context, leadId, { name, language });
    return NextResponse.json({ selection }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { businessId, leadId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const cleared = await clearLeadTemplateSelection(g.context, leadId);
    if (!cleared) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
