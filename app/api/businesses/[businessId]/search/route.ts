import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { queryLeads } from "@/src/lib/tenancy/leads";

async function guard(businessId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const resolved = await resolveBusinessContext(user.id, businessId).catch(() => null);
  if (!resolved?.ok) {
    return { error: NextResponse.json({ error: "Access denied for this business." }, { status: 403 }) };
  }
  return { user, context: resolved.context };
}

type Params = { params: Promise<{ businessId: string }> };

/**
 * Fast global search: tenant-scoped lead lookup for the ⌘K palette.
 * - Requires ≥2 chars (shorter queries return [] without touching the DB).
 * - Capped at 8 minimal-payload results (id/name/email/phone/status).
 * - Small JSON keeps INP low on mobile.
 */
export async function GET(req: Request, { params }: Params) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
    if (q.length < 2) return NextResponse.json({ results: [] }, { status: 200 });

    const page = await queryLeads(g.context, {
      search: q,
      status: "",
      assignee: "",
      archived: "active",
      sort: "createdAt",
      dir: "desc",
      page: 1,
      pageSize: 8,
    });
    const results = page.leads.map((l) => ({
      id: l.id,
      name: l.name,
      email: l.email,
      phone: l.phone,
      status: l.status,
    }));
    return NextResponse.json(
      { results },
      { status: 200, headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
