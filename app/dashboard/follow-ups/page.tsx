import Link from "next/link";
import { requireUserForPage } from "@/src/lib/auth/dal";
import { listUserBusinesses } from "@/src/lib/tenancy/businesses";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { queryFollowUps } from "@/src/lib/tenancy/followups";
import { getTeamRoster } from "@/src/lib/tenancy/members";
import { hasPermission } from "@/src/lib/tenancy/roles";
import { validateFollowUpQuery } from "@/src/lib/tenancy/validation";
import { cn } from "@/src/lib/cn";
import { Badge } from "@/src/components/ui/badge";
import { Card } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { FOLLOW_UP_STATUS_BADGE, FOLLOW_UP_STATUS_LABEL, formatDateTime, type AgentOption } from "../leads/lead-status";
import { FollowUpRowActions } from "./followup-row-actions";

export const metadata = {
  title: "Follow-ups — LeadFlow BD",
};

const SCOPES = [
  { value: "upcoming", label: "Upcoming" },
  { value: "today", label: "Today" },
  { value: "overdue", label: "Overdue" },
  { value: "mine", label: "Assigned to me" },
  { value: "all", label: "All" },
] as const;

function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/**
 * Workspace follow-up center: scope tabs (upcoming / today / overdue /
 * mine / all) over tenant-scoped scheduling data, with per-row
 * complete / cancel / reopen / reschedule / delete actions.
 */
export default async function FollowUpsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUserForPage();
  const params = await searchParams;
  const requested = firstParam(params["businessId"]) || null;

  const businesses = await listUserBusinesses(user.id).catch(() => []);
  if (businesses.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Follow-ups" description="Scheduled touches across this workspace." eyebrow="Follow-ups" />
        <Card>
          <EmptyState title="No workspace yet" description="Create a workspace to start scheduling follow-ups." />
        </Card>
      </div>
    );
  }
  let resolved = requested ? await resolveBusinessContext(user.id, requested) : null;
  if (!resolved?.ok) {
    const retry = await resolveBusinessContext(user.id, businesses[0].id);
    if (!retry.ok) {
      return (
        <div className="flex flex-col gap-6">
          <PageHeader title="Follow-ups" description="Scheduled touches across this workspace." eyebrow="Follow-ups" />
          <Card>
            <EmptyState title="No workspace yet" description="Create a workspace to start scheduling follow-ups." />
          </Card>
        </div>
      );
    }
    resolved = retry;
  }
  const { business, membership } = resolved.context;

  const raw: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(params)) raw[k] = v;
  if (firstParam(params["assignee"]) === "me") raw["assignee"] = user.id;
  if (firstParam(params["scope"]) === "mine") {
    raw["scope"] = "all";
    raw["assignee"] = user.id;
  }
  const query = validateFollowUpQuery(raw);

  const [page, rosterResult] = await Promise.all([
    queryFollowUps(resolved.context, query),
    getTeamRoster(user.id, business.id).catch(() => null),
  ]);
  const agents: AgentOption[] = (rosterResult?.ok ? rosterResult.roster.members : []).map((m) => ({
    userId: m.userId,
    email: m.email,
    name: m.name,
    role: m.role,
  }));
  const assigneeName = (id: string | null) =>
    id ? (agents.find((a) => a.userId === id)?.name ?? agents.find((a) => a.userId === id)?.email ?? "Unknown") : "—";

  const canAssignOthers = hasPermission(membership.role, "leads.assign");
  const canDelete = hasPermission(membership.role, "followups.delete");
  const tabHref = (scope: string) => `/dashboard/follow-ups?businessId=${business.id}&scope=${scope}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Follow-ups"
        description={`Scheduled touches in ${business.name}. Overdue items surface automatically.`}
        eyebrow="Follow-ups"
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3 sm:px-6" role="group" aria-label="Follow-up scope">
          {SCOPES.map((s) => {
            const active = query.scope === s.value || (s.value === "mine" && query.assignee === user.id && query.scope === "all");
            return (
              <Link
                key={s.value}
                href={tabHref(s.value)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                  active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                )}
              >
                {s.label}
              </Link>
            );
          })}
        </div>

        {page.total === 0 ? (
          <EmptyState
            title="No follow-ups here"
            description="Schedule follow-ups from any lead to keep every prospect moving."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Scheduled</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assigned to</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.followUps.map((f) => (
                <TableRow key={f.id}>
                  <TableCell>
                    <Link
                      href={`/dashboard/leads/${f.leadId}?businessId=${business.id}`}
                      className="font-medium text-slate-900 hover:text-brand-700 hover:underline"
                    >
                      {f.leadName}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(f.scheduledAt)}</TableCell>
                  <TableCell>
                    <Badge variant={FOLLOW_UP_STATUS_BADGE[f.effectiveStatus] ?? "neutral"} dot>
                      {FOLLOW_UP_STATUS_LABEL[f.effectiveStatus] ?? f.effectiveStatus}
                    </Badge>
                  </TableCell>
                  <TableCell>{assigneeName(f.assignedTo)}</TableCell>
                  <TableCell className="max-w-56 truncate">{f.note ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <FollowUpRowActions
                      businessId={business.id}
                      followUp={f}
                      agents={agents}
                      canAssignOthers={canAssignOthers}
                      canDelete={canDelete}
                    />
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
