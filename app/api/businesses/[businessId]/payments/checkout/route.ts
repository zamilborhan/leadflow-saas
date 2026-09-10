import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { requireRole } from "@/src/lib/tenancy/policies";
import { isValidPlanCode } from "@/src/lib/billing/catalog";
import { initiateCheckout } from "@/src/lib/integrations/sslcommerz/service";
import { SslcommerzConfigError } from "@/src/lib/integrations/sslcommerz/config";
import { SSLCommerzError } from "@/src/lib/integrations/sslcommerz/client";

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
 * Start a paid-plan checkout. OWNER-only; the amount, currency, and
 * callback URLs are derived server-side from the static plan catalog —
 * the request names a plan and nothing else.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    requireRole(g.context, "OWNER");
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const planCode = typeof body?.["planCode"] === "string" ? body["planCode"] : "";
    if (!isValidPlanCode(planCode) || planCode === "FREE") {
      return NextResponse.json({ errors: { planCode: "Plan must be a paid plan: STARTER, GROWTH, BUSINESS, or AGENCY." } }, { status: 422 });
    }
    try {
      const result = await initiateCheckout(g.context, planCode);
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      if (err instanceof SslcommerzConfigError) {
        return NextResponse.json({ error: err.message }, { status: 503 });
      }
      if (err instanceof SSLCommerzError) {
        return NextResponse.json({ error: err.message }, { status: 502 });
      }
      throw err;
    }
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
