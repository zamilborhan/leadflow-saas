import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/lib/auth/cookies";
import { getSessionUser } from "@/src/lib/auth/sessions";
import { readJsonBody } from "@/src/lib/auth/http";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { removeMember, updateMemberRole } from "@/src/lib/tenancy/members";
import { isValidRole } from "@/src/lib/tenancy/roles";

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

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ businessId: string; userId: string }> }
) {
  try {
    const { businessId, userId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    if (!isValidRole(body?.["role"])) {
      return NextResponse.json({ errors: { role: "Role must be one of: OWNER, ADMIN, SALES." } }, { status: 422 });
    }
    const member = await updateMemberRole(g.context, userId, body["role"] as "OWNER" | "ADMIN" | "SALES");
    if (!member) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ member }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ businessId: string; userId: string }> }
) {
  try {
    const { businessId, userId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const removed = await removeMember(g.context, userId);
    if (!removed) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
