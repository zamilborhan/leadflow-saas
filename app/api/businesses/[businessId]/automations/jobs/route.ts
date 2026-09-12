import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { requirePermission } from "@/src/lib/tenancy/policies";
import { listAutomationJobs } from "@/src/lib/automation/jobs";
import { AUTOMATION_JOB_STATUSES, AUTOMATION_TRIGGERS } from "@/src/lib/automation/engine";

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

/** List queued/executed jobs, newest first. Requires automations.manage. */
export async function GET(req: Request, { params }: Params) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? "";
    const trigger = url.searchParams.get("trigger") ?? "";
    if (status && status !== "all" && !(AUTOMATION_JOB_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ errors: { status: "Unknown job status." } }, { status: 422 });
    }
    if (trigger && trigger !== "all" && !(AUTOMATION_TRIGGERS as readonly string[]).includes(trigger)) {
      return NextResponse.json({ errors: { trigger: "Unknown trigger." } }, { status: 422 });
    }
    // Permission is enforced inside the service layer via the context role.
    try {
      requirePermission(g.context, "automations.manage");
    } catch (err) {
      return tenancyErrorResponse(err);
    }
    const jobs = await listAutomationJobs(g.context.business.id, { status, trigger });
    return NextResponse.json({ jobs }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
