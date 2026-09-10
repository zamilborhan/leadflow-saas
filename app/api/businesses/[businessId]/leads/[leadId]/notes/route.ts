import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { createLeadNote, listLeadNotes } from "@/src/lib/tenancy/activities";
import { validateLeadNote } from "@/src/lib/tenancy/validation";

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

type Params = { params: Promise<{ businessId: string; leadId: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { businessId, leadId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const notes = await listLeadNotes(g.context, leadId);
    return NextResponse.json({ notes }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { businessId, leadId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const parsed = validateLeadNote(await readJsonBody(req));
    if (!parsed.ok || !parsed.value) {
      return NextResponse.json({ errors: parsed.errors }, { status: 422 });
    }
    const { note } = await createLeadNote(g.context, leadId, parsed.value.body);
    return NextResponse.json({ note }, { status: 201 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
