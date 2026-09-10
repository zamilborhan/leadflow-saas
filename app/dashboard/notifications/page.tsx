import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUserForPage } from "@/src/lib/auth/dal";
import { listUserBusinesses } from "@/src/lib/tenancy/businesses";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import {
  listNotifications,
  syncConnectionNotifications,
  syncFollowUpNotifications,
  unreadNotificationCount,
} from "@/src/lib/tenancy/notifications";
import { validateNotificationQuery } from "@/src/lib/tenancy/validation";
import { Badge } from "@/src/components/ui/badge";
import { Card } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { MarkAllReadButton, MarkReadButton, SyncNotificationsButton } from "./notification-actions";
import { NOTIFICATION_TYPE_BADGE, NOTIFICATION_TYPE_LABEL, formatDateTime } from "./notification-labels";

export const metadata = {
  title: "Notifications — LeadFlow BD",
};

function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/**
 * In-app notification center: my notifications in this workspace, newest
 * first, with unread filter, per-row mark-as-read, mark-all-as-read, and
 * a refresh that regenerates derived alerts (due/overdue follow-ups,
 * connection expiry). Tenant- and role-aware: rows are fan-out addressed
 * to the viewer at emit time.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUserForPage();
  const params = await searchParams;
  const requested = firstParam(params["businessId"]) || null;

  const businesses = await listUserBusinesses(user.id).catch(() => []);
  if (businesses.length === 0) notFound();
  let resolved = requested ? await resolveBusinessContext(user.id, requested) : null;
  if (!resolved?.ok) {
    const retry = await resolveBusinessContext(user.id, businesses[0].id);
    if (!retry.ok) notFound();
    resolved = retry;
  }
  const { business } = resolved.context;

  const raw: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(params)) raw[k] = v;
  const query = validateNotificationQuery(raw);

  // Regenerate derived alerts so due/overdue items never need a cron.
  await syncFollowUpNotifications(business.id).catch(() => ({ created: 0, skipped: 0 }));
  await syncConnectionNotifications(business.id).catch(() => ({ created: 0, skipped: 0 }));

  const [notifications, unread] = await Promise.all([
    listNotifications(resolved.context, query).catch(() => []),
    unreadNotificationCount(resolved.context).catch(() => 0),
  ]);

  const tabHref = (unreadOnly: boolean) =>
    `/dashboard/notifications?businessId=${business.id}${unreadOnly ? "&unreadOnly=1" : ""}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifications"
        description={`Your alerts in ${business.name}${unread > 0 ? ` — ${unread} unread.` : ". You're all caught up."}`}
        eyebrow="Notifications"
        actions={
          <>
            <SyncNotificationsButton businessId={business.id} />
            <MarkAllReadButton businessId={business.id} disabled={unread === 0} />
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3 sm:px-6" role="group" aria-label="Notification filter">
          <Link
            href={tabHref(false)}
            aria-current={!query.unreadOnly ? "true" : undefined}
            className={
              !query.unreadOnly
                ? "rounded-full bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
                : "rounded-full bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-200"
            }
          >
            All
          </Link>
          <Link
            href={tabHref(true)}
            aria-current={query.unreadOnly ? "true" : undefined}
            className={
              query.unreadOnly
                ? "rounded-full bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
                : "rounded-full bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-200"
            }
          >
            Unread{unread > 0 ? ` (${unread})` : ""}
          </Link>
        </div>

        {notifications.length === 0 ? (
          <EmptyState
            title={query.unreadOnly ? "No unread notifications" : "No notifications yet"}
            description="Assignments, due follow-ups, failures, and expiry alerts land here."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {notifications.map((n) => (
                <TableRow key={n.id}>
                  <TableCell className="whitespace-nowrap">
                    <Badge variant={NOTIFICATION_TYPE_BADGE[n.type] ?? "neutral"} dot>
                      {NOTIFICATION_TYPE_LABEL[n.type] ?? n.type}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <p className="font-medium text-slate-900">{n.title}</p>
                    {n.body ? <p className="mt-0.5 max-w-96 text-sm text-slate-500">{n.body}</p> : null}
                    {n.leadId ? (
                      <p className="mt-1 text-sm">
                        <Link
                          href={`/dashboard/leads/${n.leadId}?businessId=${business.id}`}
                          className="font-medium text-brand-700 hover:text-brand-800 hover:underline"
                        >
                          Open lead →
                        </Link>
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(n.createdAt)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {n.readAt ? (
                      <span className="text-sm text-slate-400">Read</span>
                    ) : (
                      <Badge variant="brand" dot>
                        Unread
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {n.readAt ? null : (
                      <MarkReadButton businessId={business.id} notificationId={n.id} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
