import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { deleteLead, getLead, updateLead } from "@/src/lib/tenancy/leads";
import { validateUpdateLead } from "@/src/lib/tenancy/validation";
import { emitAutomationTrigger } from "@/src/lib/automation/jobs";

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
    const lead = await getLead(g.context, leadId);
    if (!lead) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ lead }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { businessId, leadId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const parsed = validateUpdateLead(await readJsonBody(req));
    if (!parsed.ok || !parsed.value) {
      return NextResponse.json({ errors: parsed.errors }, { status: 422 });
    }
    const before = await getLead(g.context, leadId);
    const lead = await updateLead(g.context, leadId, parsed.value);
    if (!lead) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Fire STATUS_CHANGED_TO_INTERESTED when a lead newly turns interested.
    if (before && before.status !== "INTERESTED" && lead.status === "INTERESTED") {
      try {
        await emitAutomationTrigger(businessId, "STATUS_CHANGED_TO_INTERESTED", lead.id);
      } catch {
        // Logged inside the emitter; the update stands.
      }
    }
    return NextResponse.json({ lead }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { businessId, leadId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const removed = await deleteLead(g.context, leadId);
    if (!removed) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
