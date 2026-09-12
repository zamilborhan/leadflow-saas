import Link from "next/link";
import { requireUserForPage } from "@/src/lib/auth/dal";
import { listUserBusinesses } from "@/src/lib/tenancy/businesses";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { queryLeads } from "@/src/lib/tenancy/leads";
import { getTeamRoster } from "@/src/lib/tenancy/members";
import { hasPermission } from "@/src/lib/tenancy/roles";
import { validateLeadQuery } from "@/src/lib/tenancy/validation";
import { Badge } from "@/src/components/ui/badge";
import { Card } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { LeadFilterBar, type LeadFilters } from "./filter-bar";
import { LeadFormDialog } from "./lead-form-dialog";
import { LeadListPagination } from "./list-pagination";
import { LEAD_STATUS_BADGE, LEAD_STATUS_LABEL, type AgentOption } from "./lead-status";

export const metadata = {
  title: "Leads — LeadFlow",
};

function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function SortLink({
  label,
  field,
  base,
  current,
}: {
  label: string;
  field: string;
  base: string;
  current: { sort: string; dir: string };
}) {
  const active = current.sort === field;
  const nextDir = active && current.dir === "desc" ? "asc" : "desc";
  return (
    <Link
      href={`${base}&sort=${field}&dir=${nextDir}&page=1`}
      className="inline-flex items-center gap-1 hover:text-slate-900"
      aria-label={`Sort by ${label} ${active && current.dir === "desc" ? "ascending" : "descending"}`}
    >
      {label}
      <span aria-hidden="true" className={active ? "text-brand-700" : "text-slate-300"}>
        {active && current.dir === "asc" ? "▲" : "▼"}
      </span>
    </Link>
  );
}

/**
 * CRM lead list wired to tenant-scoped search: text search, status /
 * assignee / archived filters, sorting, and pagination — all through the
 * list URL so views are shareable and every read stays in-workspace.
 */
export default async function LeadsPage({
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
        <PageHeader title="Leads" description="Every prospect in this workspace." eyebrow="CRM" />
        <Card>
          <EmptyState
            title="No workspace yet"
            description="Create a workspace to start capturing leads."
          />
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
          <PageHeader title="Leads" description="Every prospect in this workspace." eyebrow="CRM" />
          <Card>
            <EmptyState title="No workspace yet" description="Create a workspace to start capturing leads." />
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
  const query = validateLeadQuery(raw);

  const [page, rosterResult] = await Promise.all([
    queryLeads(resolved.context, query),
    getTeamRoster(user.id, business.id).catch(() => null),
  ]);
  const agents: AgentOption[] = (rosterResult?.ok ? rosterResult.roster.members : []).map((m) => ({
    userId: m.userId,
    email: m.email,
    name: m.name,
    role: m.role,
  }));
  const assigneeName = (id: string | null) =>
    id ? (agents.find((a) => a.userId === id)?.name ?? agents.find((a) => a.userId === id)?.email ?? "—") : "—";

  const canAssign = hasPermission(membership.role, "leads.assign");
  const base = `/dashboard/leads?businessId=${business.id}&search=${encodeURIComponent(query.search)}&status=${query.status}&assignee=${encodeURIComponent(query.assignee)}&archived=${query.archived}&pageSize=${query.pageSize}`;
  const initial: LeadFilters = {
    search: query.search,
    status: query.status,
    assignee: firstParam(params["assignee"]),
    archived: query.archived,
    sort: query.sort,
    dir: query.dir,
    pageSize: query.pageSize,
  };
  const sortState = { sort: query.sort, dir: query.dir };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Leads"
        description="Manage and track all your incoming leads."
        eyebrow="CRM"
        actions={
          <LeadFormDialog businessId={business.id} agents={agents} canAssign={canAssign} triggerLabel="Add lead" />
        }
      />

      <Card className="overflow-hidden">
        <div className="border-b border-slate-100">
          <LeadFilterBar businessId={business.id} initial={initial} agents={agents} />
        </div>
        {page.total === 0 ? (
          <EmptyState
            title={query.search || query.status || query.assignee ? "No leads match your filters" : "No leads yet"}
            description={
              query.archived === "archived"
                ? "Nothing is archived. Archived leads can be restored from here."
                : "No leads have been added to this workspace yet. Add your first lead or connect Facebook to auto-import."
            }
            action={<LeadFormDialog businessId={business.id} agents={agents} canAssign={canAssign} triggerLabel="Add your first lead" />}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <SortLink label="Lead" field="name" base={base} current={sortState} />
                </TableHead>
                <TableHead>
                  <SortLink label="Status" field="status" base={base} current={sortState} />
                </TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>Assigned to</TableHead>
                <TableHead>
                  <SortLink label="Follow-up" field="nextFollowUpAt" base={base} current={sortState} />
                </TableHead>
                <TableHead>
                  <SortLink label="Added" field="createdAt" base={base} current={sortState} />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.leads.map((lead) => (
                <TableRow key={lead.id} className="group">
                  <TableCell>
                    <span className="flex items-center gap-2.5">
                      <span
                        aria-hidden="true"
                        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700"
                      >
                        {(lead.name.trim()[0] ?? "?").toUpperCase()}
                      </span>
                      <span className="min-w-0">
                        <Link
                          href={`/dashboard/leads/${lead.id}?businessId=${business.id}`}
                          className="block truncate font-medium text-slate-900 group-hover:text-brand-700 hover:underline"
                        >
                          {lead.name}
                        </Link>
                        {lead.email ? <span className="block truncate text-xs font-normal text-slate-500">{lead.email}</span> : null}
                      </span>
                    </span>
                    {lead.archivedAt ? (
                      <Badge variant="neutral" className="mt-1">
                        Archived
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={LEAD_STATUS_BADGE[lead.status] ?? "neutral"} dot>
                      {LEAD_STATUS_LABEL[lead.status] ?? lead.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{lead.campaignName ?? lead.source ?? "—"}</TableCell>
                  <TableCell>{assigneeName(lead.assignedTo)}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(lead.nextFollowUpAt)}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(lead.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {page.totalPages > 1 ? (
          <LeadListPagination page={page.page} pageSize={page.pageSize} total={page.total} />
        ) : null}
      </Card>
    </div>
  );
}
