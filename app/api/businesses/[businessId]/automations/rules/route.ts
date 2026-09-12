import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { createAutomationRule, listAutomationRules } from "@/src/lib/automation/rules";
import { isValidTrigger } from "@/src/lib/automation/engine";

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

/** List automation rules (auto-seeds workspace defaults on first use). Requires automations.manage. */
export async function GET(_req: Request, { params }: Params) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const rules = await listAutomationRules(g.context);
    return NextResponse.json({ rules }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

/** Create a custom rule for a trigger with a config patch. Requires automations.manage. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const trigger = typeof body?.["trigger"] === "string" ? body["trigger"] : "";
    const name = typeof body?.["name"] === "string" ? body["name"] : "";
    const errors: Record<string, string> = {};
    if (!isValidTrigger(trigger)) errors["trigger"] = "Trigger must be NEW_LEAD, NO_CONTACT_AFTER_TIME, or STATUS_CHANGED_TO_INTERESTED.";
    if (!name.trim()) errors["name"] = "Rule name is required.";
    else if (name.trim().length > 120) errors["name"] = "Rule name must be 120 characters or fewer.";
    if (Object.keys(errors).length > 0) return NextResponse.json({ errors }, { status: 422 });
    try {
      const rule = await createAutomationRule(g.context, { trigger, name: name.trim(), config: body?.["config"] ?? {} });
      return NextResponse.json({ rule }, { status: 201 });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Invalid config:")) {
        return NextResponse.json({ errors: { config: err.message } }, { status: 422 });
      }
      throw err;
    }
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
