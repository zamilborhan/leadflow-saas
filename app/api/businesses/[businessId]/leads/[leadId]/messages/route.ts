import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { listLeadMessages, queueTemplateMessage } from "@/src/lib/integrations/whatsapp/messages";
import { TemplateSendError } from "@/src/lib/integrations/whatsapp/template-parse";

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

/** Lead message history, newest first. Membership read (route-guarded). */
export async function GET(_req: Request, { params }: Params) {
  try {
    const { businessId, leadId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const messages = await listLeadMessages(g.context, leadId);
    return NextResponse.json({ messages }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

/**
 * Queue a template message for a lead and drain due rows inline.
 * Requires whatsapp.send. Responds with the row in its post-drain state —
 * callers must poll GET for later transitions (acceptance is not
 * delivery; receipts arrive via webhook).
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { businessId, leadId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const templateName = typeof body?.["templateName"] === "string" ? body["templateName"].trim() : "";
    const templateLanguage = typeof body?.["templateLanguage"] === "string" ? body["templateLanguage"].trim() : "";
    const rawVariables = body?.["variables"];
    const errors: Record<string, string> = {};
    if (!templateName) errors["templateName"] = "A template name is required.";
    if (!templateLanguage) errors["templateLanguage"] = "A template language is required.";
    if (rawVariables !== undefined && (typeof rawVariables !== "object" || rawVariables === null || Array.isArray(rawVariables))) {
      errors["variables"] = "Variables must be an object of key/value strings.";
    }
    if (Object.keys(errors).length > 0) {
      return NextResponse.json({ errors }, { status: 422 });
    }
    const variables: Record<string, string> = {};
    for (const [k, v] of Object.entries((rawVariables ?? {}) as Record<string, unknown>)) {
      if (typeof v === "string") variables[k] = v;
    }
    try {
      const message = await queueTemplateMessage(g.context, leadId, {
        templateName,
        templateLanguage,
        variables,
      });
      return NextResponse.json({ message }, { status: 201 });
    } catch (err) {
      if (err instanceof TemplateSendError) {
        return NextResponse.json({ errors: { variables: err.message } }, { status: 422 });
      }
      throw err;
    }
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
