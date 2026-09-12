import { NextResponse } from "next/server";
import { requirePermission, superAdminErrorResponse } from "@/src/lib/admin/guard";
import { listUsersAdmin } from "@/src/lib/admin/users";
import { listBusinessesAdmin } from "@/src/lib/admin/businesses";
import { listLeadsAdmin } from "@/src/lib/admin/leads";
import { listSubscriptionsAdmin } from "@/src/lib/admin/subscriptions";
import { listAuditEvents, logAdminAction } from "@/src/lib/admin/audit";

const DATASETS = ["users", "businesses", "leads", "subscriptions", "audit"] as const;
type Dataset = (typeof DATASETS)[number];

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}

/**
 * Permission-controlled, server-generated CSV export.
 * - users/businesses/leads/subscriptions: capped at 1000 rows, no secrets
 *   (emails are business data; password hashes/tokens are never selected).
 * - Every export is audit-logged via logAdminAction.
 */
export async function GET(req: Request) {
  try {
    const g = await requirePermission("analytics.view");
    if ("response" in g) return g.response;
    const url = new URL(req.url);
    const dataset = url.searchParams.get("dataset") as Dataset | null;
    if (!dataset || !DATASETS.includes(dataset)) {
      return NextResponse.json({ error: `dataset must be one of: ${DATASETS.join(", ")}.` }, { status: 400 });
    }
    let rows: Array<Record<string, unknown>> = [];
    if (dataset === "users") {
      const page = await listUsersAdmin({ pageSize: 100 });
      rows = page.users.map((u) => ({ id: u.id, email: u.email, name: u.name, status: u.status, businesses: u.businessCount, createdAt: u.createdAt }));
    } else if (dataset === "businesses") {
      const page = await listBusinessesAdmin({ pageSize: 100 });
      rows = page.businesses.map((b) => ({ id: b.id, name: b.name, ownerEmail: b.ownerEmail, status: b.status, plan: b.planCode, members: b.memberCount, leads: b.leadCount, createdAt: b.createdAt }));
    } else if (dataset === "leads") {
      const page = await listLeadsAdmin({ pageSize: 100 });
      rows = page.leads.map((l) => ({ id: l.id, name: l.name, email: l.email, status: l.status, source: l.source, business: l.businessName, createdAt: l.createdAt }));
    } else if (dataset === "subscriptions") {
      const page = await listSubscriptionsAdmin({ pageSize: 100 });
      rows = page.subscriptions.map((s) => ({ businessId: s.businessId, business: s.businessName, plan: s.planCode, status: s.status, cycle: s.billingCycle, renewal: s.currentPeriodEnd }));
    } else {
      const { events } = await listAuditEvents(200);
      rows = events.map((e) => ({ actor: e.actor, action: e.action, target: e.target, at: e.createdAt }));
    }
    await logAdminAction({
      actorEmail: g.user.email,
      action: "export.generated",
      targetType: "dataset",
      targetId: dataset,
      metadata: { rows: rows.length },
    });
    return new NextResponse(toCsv(rows), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="leadflow-${dataset}.csv"`,
      },
    });
  } catch (err) {
    return superAdminErrorResponse(err);
  }
}
