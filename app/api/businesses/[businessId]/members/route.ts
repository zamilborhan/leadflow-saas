import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { readJsonBody } from "@/src/lib/auth/http";
import { listMembers } from "@/src/lib/tenancy/businesses";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { inviteMember } from "@/src/lib/tenancy/members";
import { requirePermission } from "@/src/lib/tenancy/policies";
import { isValidRole } from "@/src/lib/tenancy/roles";
import { findUserById } from "@/src/lib/auth/users";

async function guard(businessId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const resolved = await resolveBusinessContext(user.id, businessId);
  if (!resolved.ok) {
    return { error: NextResponse.json({ error: "Access denied for this business." }, { status: 403 }) };
  }
  return { user, context: resolved.context };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    requirePermission(g.context, "members.read");
    const memberships = await listMembers(businessId);
    // Enrich with display identity (email/name) for assignee pickers and
    // rosters. Password hashes never leave users.ts.
    const members = [];
    for (const m of memberships) {
      const user = await findUserById(m.userId).catch(() => null);
      members.push({
        ...m,
        email: user?.email ?? null,
        name: user?.name ?? null,
        status: user?.status ?? "UNKNOWN",
      });
    }
    return NextResponse.json({ members }, { status: 200 });
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
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const email = typeof body?.["email"] === "string" ? (body["email"] as string) : "";
    const role = body?.["role"];
    if (!email || !isValidRole(role)) {
      return NextResponse.json(
        { errors: { email: email ? undefined : "Email is required.", role: "Role must be one of: OWNER, ADMIN, SALES." } },
        { status: 422 }
      );
    }
    try {
      const { apiRateLimiter, API_RATE_LIMITS } = await import("@/src/lib/auth/rate-limit");
      const budget = API_RATE_LIMITS.memberInvite;
      const decision = apiRateLimiter.check(
        `invite:${g.user.id}:${businessId}`,
        budget.limit,
        budget.windowMs
      );
      if (!decision.allowed) {
        return NextResponse.json({ error: "Too many invites. Please try again later." }, { status: 429 });
      }
    } catch {
      // Limiter failure must not block legitimate invites.
    }
    const member = await inviteMember(g.context, email, role);
    return NextResponse.json({ member }, { status: 201 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
