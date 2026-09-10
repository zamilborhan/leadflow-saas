import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUserForPage } from "@/src/lib/auth/dal";
import { findUserById } from "@/src/lib/auth/users";
import { listUserBusinesses } from "@/src/lib/tenancy/businesses";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { listLeadActivities, listLeadNotes } from "@/src/lib/tenancy/activities";
import { listLeadFollowUps } from "@/src/lib/tenancy/followups";
import { getLead } from "@/src/lib/tenancy/leads";
import { getTeamRoster } from "@/src/lib/tenancy/members";
import { hasPermission } from "@/src/lib/tenancy/roles";
import { getLeadTemplateSelection, listTemplates } from "@/src/lib/integrations/whatsapp/templates";
import { listLeadMessages } from "@/src/lib/integrations/whatsapp/messages";
import { Badge } from "@/src/components/ui/badge";
import { ButtonLink } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { FollowUpFormDialog } from "../../follow-ups/followup-form-dialog";
import { FollowUpRowActions } from "../../follow-ups/followup-row-actions";
import { LeadFormDialog } from "../lead-form-dialog";
import { FOLLOW_UP_STATUS_BADGE, FOLLOW_UP_STATUS_LABEL, LEAD_STATUS_BADGE, LEAD_STATUS_LABEL, type AgentOption } from "../lead-status";
import { LeadTemplatePicker } from "./template-picker";
import { MessageComposer } from "./message-composer";
import { AddNoteForm } from "./add-note-form";
import { LeadDetailActions } from "./detail-actions";
import { LogActivityForm } from "./log-activity-form";
import { ActivityTimeline } from "./timeline";
import { ConversationThread } from "./conversation-thread";

export const metadata = {
  title: "Lead details — LeadFlow BD",
};

function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-slate-900">{value}</dd>
    </div>
  );
}

/**
 * Lead details: full prospect record scoped to the workspace, with edit,
 * status, assignment, archive, and delete flows gated by role.
 */
export default async function LeadDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ leadId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUserForPage();
  const { leadId } = await params;
  const query = await searchParams;
  const requested = firstParam(query["businessId"]) || null;

  const businesses = await listUserBusinesses(user.id).catch(() => []);
  if (businesses.length === 0) notFound();
  let resolved = requested ? await resolveBusinessContext(user.id, requested) : null;
  if (!resolved?.ok) {
    const retry = await resolveBusinessContext(user.id, businesses[0].id);
    if (!retry.ok) notFound();
    resolved = retry;
  }
  const { business, membership } = resolved.context;

  const [lead, rosterResult] = await Promise.all([
    getLead(resolved.context, leadId),
    getTeamRoster(user.id, business.id).catch(() => null),
  ]);
  if (!lead) notFound();

  const [activities, notes, followUps] = await Promise.all([
    listLeadActivities(resolved.context, lead.id, { order: "desc", limit: 100 }),
    listLeadNotes(resolved.context, lead.id, { order: "desc", limit: 100 }),
    listLeadFollowUps(resolved.context, lead.id).catch(() => []),
  ]);
  const [templates, templateSelection] = await Promise.all([
    listTemplates(resolved.context).catch(() => []),
    getLeadTemplateSelection(resolved.context, lead.id).catch(() => null),
  ]);
  const messages = await listLeadMessages(resolved.context, lead.id).catch(() => []);
  const canSend = hasPermission(membership.role, "whatsapp.send");

  // Resolve display names for everyone referenced by the timeline/notes.
  const nameCache = new Map<string, string>();
  async function displayName(userId: string | null): Promise<string> {
    if (!userId) return "System";
    const cached = nameCache.get(userId);
    if (cached) return cached;
    const found = await findUserById(userId).catch(() => null);
    const label = found ? (found.name ?? found.email) : "Unknown user";
    nameCache.set(userId, label);
    return label;
  }
  const timeline = [];
  for (const a of activities) {
    timeline.push({
      id: a.id,
      type: a.type,
      body: a.body,
      actorName: await displayName(a.actorId),
      createdAt: a.createdAt,
    });
  }
  const noteItems = [];
  for (const n of notes) {
    noteItems.push({ ...n, authorName: await displayName(n.authorId) });
  }

  const agents: AgentOption[] = (rosterResult?.ok ? rosterResult.roster.members : []).map((m) => ({
    userId: m.userId,
    email: m.email,
    name: m.name,
    role: m.role,
  }));
  const assignee = lead.assignedTo ? agents.find((a) => a.userId === lead.assignedTo) : null;

  const canEdit = hasPermission(membership.role, "leads.update");
  const canAssign = hasPermission(membership.role, "leads.assign");
  const canDelete = hasPermission(membership.role, "leads.delete");
  const canSchedule = hasPermission(membership.role, "followups.create");
  const canDeleteFollowUp = hasPermission(membership.role, "followups.delete");
  const backHref = `/dashboard/leads?businessId=${business.id}`;
  const assigneeNameOf = (id: string | null) =>
    id ? (agents.find((a) => a.userId === id)?.name ?? agents.find((a) => a.userId === id)?.email ?? "Unknown") : "—";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={lead.name}
        description={`Prospect in ${business.name}.`}
        eyebrow="Lead"
        actions={
          <>
            <ButtonLink href={backHref} variant="outline">
              Back to leads
            </ButtonLink>
            {canEdit ? (
              <LeadFormDialog
                businessId={business.id}
                lead={lead}
                agents={agents}
                canAssign={canAssign}
                triggerLabel="Edit lead"
                triggerVariant="outline"
              />
            ) : null}
          </>
        }
      />

      {lead.archivedAt ? (
        <div role="status" className="rounded-xl border border-slate-300 bg-slate-100 px-5 py-3 text-sm text-slate-600">
          Archived {formatDateTime(lead.archivedAt)}. Archived leads stay out of the active pipeline and dashboard metrics.
        </div>
      ) : null}

      <LeadDetailActions
        businessId={business.id}
        leadId={lead.id}
        leadName={lead.name}
        status={lead.status}
        archived={Boolean(lead.archivedAt)}
        canEdit={canEdit}
        canDelete={canDelete}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Contact</CardTitle>
            <CardDescription>How to reach this prospect.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <DetailItem label="Status" value={LEAD_STATUS_LABEL[lead.status] ?? lead.status} />
              <DetailItem label="Assigned to" value={assignee ? (assignee.name ?? assignee.email) : "Unassigned"} />
              <DetailItem label="Email" value={lead.email ?? "—"} />
              <DetailItem label="Phone" value={lead.phone ?? "—"} />
              <DetailItem label="Last contacted" value={formatDateTime(lead.lastContactedAt)} />
              <DetailItem label="Next follow-up" value={formatDateTime(lead.nextFollowUpAt)} />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Attribution</CardTitle>
            <CardDescription>Where this prospect came from.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-5">
              <DetailItem label="Source" value={lead.source ?? "—"} />
              <DetailItem label="Campaign" value={lead.campaignName ?? "—"} />
              <DetailItem label="Ad set" value={lead.adSetName ?? "—"} />
              <DetailItem label="Ad" value={lead.adName ?? "—"} />
              <DetailItem label="Facebook lead ID" value={lead.facebookLeadId ?? "—"} />
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Record</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            <DetailItem label="Lead ID" value={lead.id} />
            <DetailItem label="Added" value={formatDateTime(lead.createdAt)} />
            <DetailItem label="Last updated" value={formatDateTime(lead.updatedAt)} />
          </dl>
          <div className="mt-4">
            <Badge variant={LEAD_STATUS_BADGE[lead.status] ?? "neutral"} dot>
              {LEAD_STATUS_LABEL[lead.status] ?? lead.status}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>Follow-ups</CardTitle>
              <CardDescription>Scheduled touches for this prospect, soonest first.</CardDescription>
            </div>
            {canSchedule ? (
              <FollowUpFormDialog
                businessId={business.id}
                leadId={lead.id}
                agents={agents}
                canAssignOthers={canAssign}
                triggerLabel="Schedule"
              />
            ) : null}
          </div>
        </CardHeader>
        {followUps.length === 0 ? (
          <EmptyState
            title="No follow-ups scheduled"
            description="Schedule the first touch so this prospect never goes cold."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
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
              {followUps.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(f.scheduledAt)}</TableCell>
                  <TableCell>
                    <Badge variant={FOLLOW_UP_STATUS_BADGE[f.effectiveStatus] ?? "neutral"} dot>
                      {FOLLOW_UP_STATUS_LABEL[f.effectiveStatus] ?? f.effectiveStatus}
                    </Badge>
                  </TableCell>
                  <TableCell>{assigneeNameOf(f.assignedTo)}</TableCell>
                  <TableCell className="max-w-56 truncate">{f.note ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <FollowUpRowActions
                      businessId={business.id}
                      followUp={f}
                      agents={agents}
                      canAssignOthers={canAssign}
                      canDelete={canDeleteFollowUp}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Activity timeline</CardTitle>
            <CardDescription>Newest first. Every entry records who did what, and when.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ActivityTimeline entries={timeline} />
            {canEdit ? <LogActivityForm businessId={business.id} leadId={lead.id} /> : null}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <ConversationThread messages={messages} />
          {canSend && lead.phone ? (
            <MessageComposer
              businessId={business.id}
              leadId={lead.id}
              leadPhone={lead.phone}
              templates={templates}
              selection={templateSelection}
              initialMessages={messages}
            />
          ) : null}
          {canEdit ? (
            <LeadTemplatePicker
              businessId={business.id}
              leadId={lead.id}
              templates={templates}
              initial={templateSelection}
            />
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Notes</CardTitle>
              <CardDescription>Agent notes. Each note also appears in the timeline.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {canEdit ? <AddNoteForm businessId={business.id} leadId={lead.id} /> : null}
              {noteItems.length === 0 ? (
                <EmptyState
                  title="No notes yet"
                  description="Add the first note to keep context the whole team can see."
                />
              ) : (
                <ul className="flex flex-col gap-4">
                  {noteItems.map((note) => (
                    <li key={note.id} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <p className="text-sm whitespace-pre-wrap text-slate-800">{note.body}</p>
                      <p className="mt-2 text-xs text-slate-500">
                        {note.authorName} · <time dateTime={note.createdAt}>{formatDateTime(note.createdAt)}</time>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <p className="text-sm">
        <Link href={backHref} className="font-medium text-brand-700 hover:text-brand-800 hover:underline">
          ← Back to all leads
        </Link>
      </p>
    </div>
  );
}
