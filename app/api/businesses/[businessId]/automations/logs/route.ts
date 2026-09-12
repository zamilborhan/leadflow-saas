import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { requirePermission } from "@/src/lib/tenancy/policies";
import { listAutomationLogs } from "@/src/lib/automation/jobs";
import { AUTOMATION_ACTIONS, AUTOMATION_LOG_STATUSES } from "@/src/lib/automation/engine";

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

/**
 * Automation logs, newest first (max 200). SUCCESS rows are the automation
 * log, FAILED rows are the failure log, SKIPPED rows explain inaction.
 * Requires automations.manage.
 */
export async function GET(req: Request, { params }: Params) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    try {
      requirePermission(g.context, "automations.manage");
    } catch (err) {
      return tenancyErrorResponse(err);
    }
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? "";
    const action = url.searchParams.get("action") ?? "";
    const leadId = url.searchParams.get("leadId") ?? "";
    if (status && status !== "all" && !(AUTOMATION_LOG_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ errors: { status: "Unknown log status." } }, { status: 422 });
    }
    if (
      action &&
      action !== "all" &&
      !(AUTOMATION_ACTIONS as readonly string[]).includes(action) &&
      action !== "TRIGGER"
    ) {
      return NextResponse.json({ errors: { action: "Unknown action." } }, { status: 422 });
    }
    const logs = await listAutomationLogs(g.context.business.id, { status, action, leadId });
    return NextResponse.json({ logs }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
