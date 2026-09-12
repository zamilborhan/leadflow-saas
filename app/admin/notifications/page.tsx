import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { allOrEmpty } from "@/src/lib/admin/query";
import { NotificationTable } from "@/src/prisma/tables";

export const metadata = { title: "Notifications — Super-admin — LeadFlow BD" };

/**
 * Platform announcement center.
 * BACKEND REQUIREMENT: in-app Notification rows are per-user workspace
 * fan-outs, not platform broadcasts. Platform announcements need a new
 * `Announcement { title, body, type, audience, planCode?, businessId?,
 * publishAt, expiresAt, status }` table + publish worker. Until then this
 * page shows live notification volume and the exact contract to build.
 */
export default async function AdminNotificationsPage() {
  await requireSuperAdminForPage("/admin/notifications");
  const notifications = await allOrEmpty(NotificationTable.select("id", "readAt").all());
  const total = notifications.length;
  const unread = notifications.filter((x) => x.readAt === null).length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Notifications" description="Platform announcements and live notification volume." eyebrow="Super-admin" />
      <Card>
        <CardHeader>
          <CardTitle>Live notification volume</CardTitle>
          <CardDescription>{total} workspace notifications on platform · {unread} unread.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-slate-600">
          <p>
            Workspace notifications (lead assigned, follow-up due, WhatsApp failed, …) already fan out
            per recipient. Platform-wide announcements (maintenance, features, disruptions) need the
            Announcement model before publishing is safe — this page intentionally ships the read side
            first rather than a fake publish button.
          </p>
          <div className="rounded-lg bg-slate-50 p-4 font-mono text-xs">
            Announcement {"{ title, body, type: info|maintenance|feature|alert, audience: everyone|plan|workspace|users,"}
            <br />
            {"  planCode?, businessId?, userIds?, publishAt, expiresAt, status: draft|scheduled|published|expired }"}
          </div>
          <p className="text-xs text-slate-400">
            Draft → Scheduled → Published → Expired lifecycle, audience targeting, and audit logging
            land with the table. No destructive action exists on this page.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
