import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { requirePermission } from "@/src/lib/tenancy/policies";
import { emitPaymentFailed } from "@/src/lib/tenancy/notifications";

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

type Params = { params: Promise<{ businessId: string }> };

/**
 * Billing-webhook seam: raise a PAYMENT_FAILED notification for managers.
 * Requires businesses.update (OWNER/ADMIN). Idempotent per reference.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    requirePermission(g.context, "businesses.update");
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const reference = typeof body?.["reference"] === "string" ? body["reference"].trim() : "";
    const amount = typeof body?.["amount"] === "string" ? body["amount"] : undefined;
    const detail = typeof body?.["detail"] === "string" ? body["detail"] : undefined;
    if (!reference) {
      return NextResponse.json({ errors: { reference: "Payment reference is required." } }, { status: 422 });
    }
    try {
      const notifications = await emitPaymentFailed(g.context.business.id, { reference, amount, detail });
      return NextResponse.json({ notifications }, { status: 201 });
    } catch (err) {
      if (err instanceof Error) {
        return NextResponse.json({ errors: { reference: err.message } }, { status: 422 });
      }
      throw err;
    }
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
