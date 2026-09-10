import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { getMessage, retryMessage } from "@/src/lib/integrations/whatsapp/messages";

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

type Params = { params: Promise<{ businessId: string; leadId: string; messageId: string }> };

/** Single message, scoped (unknown/foreign → 404). Poll this for status. */
export async function GET(_req: Request, { params }: Params) {
  try {
    const { businessId, leadId, messageId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const message = await getMessage(g.context, messageId);
    if (!message || message.leadId !== leadId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json({ message }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

/** Requeue a FAILED message with attempts left. Requires whatsapp.send. */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { businessId, leadId, messageId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const existing = await getMessage(g.context, messageId);
    if (!existing || existing.leadId !== leadId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const message = await retryMessage(g.context, messageId);
    return NextResponse.json({ message }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
