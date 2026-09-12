import { NextResponse } from "next/server";
import { requirePermission, superAdminErrorResponse } from "@/src/lib/admin/guard";
import { listUsersAdmin } from "@/src/lib/admin/users";
import { listBusinessesAdmin } from "@/src/lib/admin/businesses";
import { listLeadsAdmin } from "@/src/lib/admin/leads";
import { listSubscriptionsAdmin } from "@/src/lib/admin/subscriptions";

/**
 * Admin command search (Ctrl+K backend). Server-side, debounced client-side,
 * capped at 5 hits per domain. Requires users.view (broadest read role).
 */
export async function GET(req: Request) {
  try {
    const g = await requirePermission("users.view");
    if ("response" in g) return g.response;
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length < 2) return NextResponse.json({ users: [], businesses: [], leads: [], subscriptions: [] });
    const [users, businesses, leads, subscriptions] = await Promise.all([
      listUsersAdmin({ search: q, pageSize: 5 }),
      listBusinessesAdmin({ search: q, pageSize: 5 }),
      listLeadsAdmin({ search: q, pageSize: 5 }),
      listSubscriptionsAdmin({ search: q, pageSize: 5 }),
    ]);
    return NextResponse.json(
      {
        users: users.users.map((u) => ({ id: u.id, label: u.email, href: `/admin/users/${u.id}` })),
        businesses: businesses.businesses.map((b) => ({ id: b.id, label: b.name, href: `/admin/businesses/${b.id}` })),
        leads: leads.leads.map((l) => ({ id: l.id, label: `${l.name} · ${l.businessName ?? ""}`, href: `/admin/leads?search=${encodeURIComponent(l.email ?? l.name)}` })),
        subscriptions: subscriptions.subscriptions.map((s) => ({
          id: s.businessId,
          label: `${s.businessName ?? s.businessId} · ${s.planCode}`,
          href: `/admin/subscriptions?search=${encodeURIComponent(s.businessId)}`,
        })),
      },
      { status: 200 }
    );
  } catch (err) {
    return superAdminErrorResponse(err);
  }
}
