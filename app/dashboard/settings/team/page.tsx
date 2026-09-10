import Link from "next/link";
import { requireUserForPage } from "@/src/lib/auth/dal";
import { getTeamRoster, type TeamMemberDTO } from "@/src/lib/tenancy/members";
import { isValidRole, type WorkspaceRole } from "@/src/lib/tenancy/roles";
import { cn } from "@/src/lib/cn";
import { Badge } from "@/src/components/ui/badge";
import { Card } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { InviteMemberDialog } from "./invite-button";
import { MemberRoleSelect, RemoveMemberButton } from "./member-actions";
import { assignableRoles } from "@/src/lib/tenancy/roles";

export const metadata = {
  title: "Team settings — LeadFlow BD",
};

const ROLE_BADGE: Record<WorkspaceRole, "brand" | "info" | "neutral"> = {
  OWNER: "brand",
  ADMIN: "info",
  SALES: "neutral",
};

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  SALES: "Sales",
};

const FILTERS = [
  { value: "", label: "Everyone" },
  { value: "SALES", label: "Sales" },
  { value: "ADMIN", label: "Admins" },
  { value: "OWNER", label: "Owners" },
] as const;

function initials(email: string, name: string | null): string {
  const base = (name ?? email).trim();
  return (base[0] ?? "?").toUpperCase();
}

function MemberRow({
  member,
  businessId,
  isSelf,
}: {
  member: TeamMemberDTO;
  businessId: string;
  isSelf: boolean;
}) {
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-800"
          >
            {initials(member.email, member.name)}
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium text-slate-900">
              {member.name ?? member.email}
              {isSelf ? <span className="ml-2 text-xs font-normal text-slate-400">(you)</span> : null}
            </p>
            <p className="truncate text-xs text-slate-500">{member.email}</p>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={ROLE_BADGE[member.role]}>{ROLE_LABEL[member.role]}</Badge>
      </TableCell>
      <TableCell>
        {member.status === "ACTIVE" ? (
          <Badge variant="success" dot>
            Active
          </Badge>
        ) : (
          <Badge variant="warning" dot>
            {member.status}
          </Badge>
        )}
      </TableCell>
      <TableCell>
        {member.canChangeRole ? (
          <MemberRoleSelect
            businessId={businessId}
            targetUserId={member.userId}
            targetEmail={member.email}
            currentRole={member.role}
            allowedRoles={member.allowedRoles}
          />
        ) : (
          <span className="text-sm text-slate-400">—</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {member.canRemove ? (
          <RemoveMemberButton businessId={businessId} targetUserId={member.userId} targetEmail={member.email} />
        ) : (
          <span className="text-sm text-slate-400">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * Team management: roster with role badges, role filter (incl. a
 * sales-only view), and invite / change-role / remove flows — every
 * action gated by the caller's workspace role.
 */
export default async function TeamSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUserForPage();
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const businessId = first(params["businessId"]) ?? null;
  const roleParam = first(params["role"]) ?? "";
  const roleFilter: WorkspaceRole | null = isValidRole(roleParam) ? roleParam : null;

  const result = await getTeamRoster(user.id, businessId);

  if (!result.ok) {
    return (
      <Card>
        <EmptyState
          title="No workspace yet"
          description="Create a workspace to start building your team."
        />
      </Card>
    );
  }

  const { roster } = result;
  const owners = roster.members.filter((m) => m.role === "OWNER").length;
  const admins = roster.members.filter((m) => m.role === "ADMIN").length;
  const sales = roster.members.filter((m) => m.role === "SALES").length;
  const visible = roleFilter ? roster.members.filter((m) => m.role === roleFilter) : roster.members;
  const query = (role: string) =>
    `/dashboard/settings/team?businessId=${roster.business.id}${role ? `&role=${role}` : ""}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Team"
        description={`Who can access ${roster.business.name}, and what they can do. You are ${ROLE_LABEL[roster.callerRole].toLowerCase()}.`}
        actions={
          roster.canInvite ? (
            <InviteMemberDialog businessId={roster.business.id} allowedRoles={[...assignableRoles(roster.callerRole)]} />
          ) : undefined
        }
      />

      <section aria-label="Team composition" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          ["Total members", String(roster.members.length)],
          ["Owners", String(owners)],
          ["Admins", String(admins)],
          ["Sales agents", String(sales)],
        ].map(([label, value]) => (
          <Card key={label}>
            <div className="px-5 py-4">
              <p className="text-sm font-medium text-slate-500">{label}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
            </div>
          </Card>
        ))}
      </section>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3 sm:px-6" role="group" aria-label="Filter by role">
          {FILTERS.map((f) => {
            const active = (roleFilter ?? "") === f.value;
            return (
              <Link
                key={f.label}
                href={query(f.value)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                  active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                )}
              >
                {f.label}
              </Link>
            );
          })}
        </div>
        {visible.length === 0 ? (
          <EmptyState
            title={roleFilter === "SALES" ? "No sales agents yet" : "No members in this view"}
            description={
              roleFilter === "SALES"
                ? "Invite sales agents so leads always have an owner."
                : "Try a different role filter."
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Change role</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((m) => (
                <MemberRow key={m.id} member={m} businessId={roster.business.id} isSelf={m.userId === user.id} />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {!roster.canInvite ? (
        <p className="text-sm text-slate-500">
          Only owners and admins manage the team — sales members have read-only access here.
        </p>
      ) : null}
    </div>
  );
}
