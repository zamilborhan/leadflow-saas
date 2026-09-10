import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { deleteAutomationRule, updateAutomationRule } from "@/src/lib/automation/rules";
import { isValidRuleStatus } from "@/src/lib/automation/engine";

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

type Params = { params: Promise<{ businessId: string; ruleId: string }> };

/**
 * Update a rule: rename, enable/disable (status ENABLED|DISABLED), or patch
 * config. Requires automations.manage.
 */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { businessId, ruleId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const errors: Record<string, string> = {};
    if (body?.["status"] !== undefined && !isValidRuleStatus(body["status"])) {
      errors["status"] = "Status must be ENABLED or DISABLED.";
    }
    if (body?.["name"] !== undefined) {
      const name = typeof body["name"] === "string" ? body["name"].trim() : "";
      if (!name) errors["name"] = "Rule name must not be empty.";
      else if (name.length > 120) errors["name"] = "Rule name must be 120 characters or fewer.";
    }
    if (Object.keys(errors).length > 0) return NextResponse.json({ errors }, { status: 422 });
    try {
      const rule = await updateAutomationRule(g.context, ruleId, {
        ...(body?.["name"] !== undefined ? { name: (body["name"] as string).trim() } : {}),
        ...(body?.["status"] !== undefined ? { status: body["status"] as string } : {}),
        ...(body?.["config"] !== undefined ? { config: body["config"] } : {}),
      });
      if (!rule) return NextResponse.json({ error: "Not found." }, { status: 404 });
      return NextResponse.json({ rule }, { status: 200 });
    } catch (err) {
      if (err instanceof Error && (err.message.startsWith("Invalid config:") || err.message.startsWith("Rule name"))) {
        return NextResponse.json({ errors: { _form: err.message } }, { status: 422 });
      }
      throw err;
    }
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

/** Delete a rule. Requires automations.manage. Jobs already run keep their logs. */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { businessId, ruleId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const removed = await deleteAutomationRule(g.context, ruleId);
    if (!removed) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
