import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { deleteFollowUp, getFollowUp, updateFollowUp } from "@/src/lib/tenancy/followups";
import { validateUpdateFollowUp } from "@/src/lib/tenancy/validation";

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

type Params = { params: Promise<{ businessId: string; followUpId: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { businessId, followUpId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const followUp = await getFollowUp(g.context, followUpId);
    if (!followUp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ followUp }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { businessId, followUpId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const parsed = validateUpdateFollowUp(await readJsonBody(req));
    if (!parsed.ok || !parsed.value) {
      return NextResponse.json({ errors: parsed.errors }, { status: 422 });
    }
    const followUp = await updateFollowUp(g.context, followUpId, parsed.value);
    if (!followUp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ followUp }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { businessId, followUpId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const removed = await deleteFollowUp(g.context, followUpId);
    if (!removed) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
