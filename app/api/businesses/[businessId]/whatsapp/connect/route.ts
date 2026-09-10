import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { connectWhatsApp } from "@/src/lib/integrations/whatsapp/service";

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

function fieldError(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return "This field is required.";
  if (value.trim().length > max) return `Must be ${max} characters or fewer.`;
  return null;
}

/**
 * Connect WhatsApp Cloud API. Verifies the credentials live against Meta
 * (phone exists and belongs to the WABA) before storing anything.
 * Requires businesses.update (OWNER/ADMIN).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const errors: Record<string, string> = {};
    const wabaError = fieldError(body?.["wabaId"], 64);
    if (wabaError) errors["wabaId"] = "A WhatsApp Business Account ID is required.";
    const phoneError = fieldError(body?.["phoneNumberId"], 64);
    if (phoneError) errors["phoneNumberId"] = "A phone number ID is required.";
    const tokenError = fieldError(body?.["accessToken"], 4096);
    if (tokenError) errors["accessToken"] = "A system user access token is required.";
    if (Object.keys(errors).length > 0) {
      return NextResponse.json({ errors }, { status: 422 });
    }
    const status = await connectWhatsApp(g.context, {
      wabaId: (body?.["wabaId"] as string).trim(),
      phoneNumberId: (body?.["phoneNumberId"] as string).trim(),
      accessToken: (body?.["accessToken"] as string).trim(),
    });
    return NextResponse.json({ connection: status }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
