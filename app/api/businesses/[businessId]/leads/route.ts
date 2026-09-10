import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { createLead, queryLeads } from "@/src/lib/tenancy/leads";
import { validateCreateLead, validateLeadQuery } from "@/src/lib/tenancy/validation";
import { emitAutomationTrigger } from "@/src/lib/automation/jobs";

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

export async function GET(
  req: Request,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    // "me" resolves to the caller's own user id for assignee filtering.
    const url = new URL(req.url);
    const raw: Record<string, string | string[] | undefined> = {};
    url.searchParams.forEach((value, key) => {
      const prev = raw[key];
      raw[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
    });
    if (raw["assignee"] === "me") raw["assignee"] = g.user.id;
    const result = await queryLeads(g.context, validateLeadQuery(raw));
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const parsed = validateCreateLead(await readJsonBody(req));
    if (!parsed.ok || !parsed.value) {
      return NextResponse.json({ errors: parsed.errors }, { status: 422 });
    }
    const lead = await createLead(g.context, parsed.value);
    // Fire NEW_LEAD automations best-effort — the lead response never fails for automation.
    try {
      await emitAutomationTrigger(businessId, "NEW_LEAD", lead.id);
    } catch {
      // Logged inside the emitter; the 201 stands.
    }
    return NextResponse.json({ lead }, { status: 201 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
