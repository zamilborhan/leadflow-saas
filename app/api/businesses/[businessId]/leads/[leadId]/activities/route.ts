import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { listLeadActivities, logLeadActivity } from "@/src/lib/tenancy/activities";
import { validateActivityQuery, validateLogLeadActivity } from "@/src/lib/tenancy/validation";

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

/**
 * System event types are emitted automatically by lead flows (create,
 * assign, status change, notes) and cannot be forged here — manual logging
 * is limited to follow-up and WhatsApp events.
 */
const MANUAL_TYPES = [
  "FOLLOW_UP_CREATED",
  "FOLLOW_UP_COMPLETED",
  "WHATSAPP_SENT",
  "WHATSAPP_RECEIVED",
] as const;

function queryOf(req: Request): Record<string, string | string[] | undefined> {
  const url = new URL(req.url);
  const raw: Record<string, string | string[] | undefined> = {};
  url.searchParams.forEach((value, key) => {
    const prev = raw[key];
    raw[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
  });
  return raw;
}

export async function GET(req: Request, { params }: Params) {
  try {
    const { businessId, leadId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const activities = await listLeadActivities(g.context, leadId, validateActivityQuery(queryOf(req)));
    return NextResponse.json({ activities }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { businessId, leadId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const parsed = validateLogLeadActivity(await readJsonBody(req));
    if (!parsed.ok || !parsed.value) {
      return NextResponse.json({ errors: parsed.errors }, { status: 422 });
    }
    if (!(MANUAL_TYPES as readonly string[]).includes(parsed.value.type)) {
      return NextResponse.json(
        { errors: { type: "This event is recorded automatically and cannot be logged manually." } },
        { status: 422 }
      );
    }
    const activity = await logLeadActivity(g.context, leadId, parsed.value.type, parsed.value.body);
    return NextResponse.json({ activity }, { status: 201 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
