/**
 * Automation action executors (server-only).
 *
 * Each action runs as the system (actor null on timeline rows) — user
 * authorization happens at the rule-management API boundary, not here.
 * Actions return SUCCESS/SKIPPED or throw on failure; the job executor in
 * jobs.ts classifies failures (retryable vs terminal) and writes the
 * FAILED logs. Every mutating action is guarded by the job's SUCCESS-log
 * check in the executor, so retries never double-apply.
 */
import {
  BusinessMemberTable,
  BusinessTable,
  FollowUpTable,
  LeadTable,
  LeadTemplateSelectionTable,
  UserTable,
  WhatsAppTemplateTable,
} from "../../prisma/tables";
import { recordLeadActivity } from "../tenancy/activities";
import { toBusinessId, toDbId } from "../tenancy/businesses";
import type { BusinessContext } from "../tenancy/context";
import { TenantNotFound } from "../tenancy/policies";
import { queueTemplateMessage } from "../integrations/whatsapp/messages";
import { pickLeastLoadedAgent, type AutomationAction, type RuleConfig } from "./engine";

export interface ActionLead {
  id: string;
  businessId: string;
  name: string;
  phone: string | null;
  status: string;
  assignedTo: string | null;
  archivedAt: string | null;
}

export type ActionResult = { status: "SUCCESS" | "SKIPPED"; detail: string };

async function loadLead(businessId: string, leadId: string): Promise<ActionLead | null> {
  let bid;
  try {
    bid = toBusinessId(businessId);
  } catch {
    return null;
  }
  const rows = await LeadTable.where((l) => l.businessId.eq(bid))
    .select("id", "businessId", "name", "phone", "status", "assignedTo", "archivedAt")
    .all();
  const row = rows.find((r) => r.id === leadId) ?? null;
  if (!row || row.businessId !== businessId) return null;
  return {
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    phone: row.phone,
    status: row.status,
    assignedTo: row.assignedTo,
    archivedAt: row.archivedAt,
  };
}

/** Synthetic OWNER context for system-initiated WhatsApp sends. */
async function systemContext(businessId: string): Promise<BusinessContext> {
  const bid = toBusinessId(businessId);
  const business = await BusinessTable.where({ id: bid })
    .select("id", "name", "ownerId", "status", "createdAt", "updatedAt")
    .first();
  if (!business) throw new TenantNotFound();
  const membership = await BusinessMemberTable.where((m) => m.businessId.eq(bid))
    .select("id", "businessId", "userId", "role", "createdAt", "updatedAt")
    .all()
    .then((rows) => rows.find((r) => r.role === "OWNER") ?? rows[0] ?? null);
  const now = new Date().toISOString();
  return {
    business: { ...business },
    membership: membership
      ? { ...membership, role: "OWNER" as const }
      : {
          id: business.ownerId,
          businessId: business.id,
          userId: business.ownerId,
          role: "OWNER" as const,
          createdAt: now,
          updatedAt: now,
        },
  } as BusinessContext;
}

async function memberUserIds(businessId: string): Promise<Array<{ userId: string; role: string }>> {
  const bid = toBusinessId(businessId);
  const rows = await BusinessMemberTable.where((m) => m.businessId.eq(bid))
    .select("userId", "role")
    .all();
  return rows
    .filter((r) => r.role === "SALES" || r.role === "ADMIN" || r.role === "OWNER")
    .map((r) => ({ userId: r.userId, role: r.role }));
}

async function openLeadCounts(businessId: string): Promise<Map<string, number>> {
  const bid = toBusinessId(businessId);
  const leads = await LeadTable.where((l) => l.businessId.eq(bid)).select("assignedTo", "archivedAt").all();
  const counts = new Map<string, number>();
  for (const lead of leads) {
    if (lead.archivedAt || !lead.assignedTo) continue;
    counts.set(lead.assignedTo, (counts.get(lead.assignedTo) ?? 0) + 1);
  }
  return counts;
}

export async function executeAssignAgent(businessId: string, leadId: string): Promise<ActionResult> {
  const lead = await loadLead(businessId, leadId);
  if (!lead) throw new TenantNotFound();
  if (lead.archivedAt) return { status: "SKIPPED", detail: "Lead is archived." };
  const members = await memberUserIds(businessId);
  if (members.length === 0) return { status: "SKIPPED", detail: "No agents in workspace." };
  const counts = await openLeadCounts(businessId);
  const agentId = pickLeastLoadedAgent(members.map((m) => ({ userId: m.userId, openLeads: counts.get(m.userId) ?? 0 })));
  if (!agentId) return { status: "SKIPPED", detail: "No agents in workspace." };
  if (lead.assignedTo === agentId) return { status: "SKIPPED", detail: "Lead already assigned to this agent." };
  await LeadTable.where({ id: toDbId(lead.id) }).update({ assignedTo: agentId } as never);
  await recordLeadActivity(businessId, lead.id, "ASSIGNED", "Assigned by automation (least-loaded agent).");
  return { status: "SUCCESS", detail: `Assigned to agent ${agentId}.` };
}

async function insertFollowUp(
  businessId: string,
  leadId: string,
  assignedTo: string | null,
  scheduledAt: string,
  note: string | null,
  activityBody: string
): Promise<string> {
  const row = await FollowUpTable.select("id").create({
    businessId: toBusinessId(businessId),
    leadId: toDbId(leadId),
    ...(assignedTo ? { assignedTo: toDbId(assignedTo) } : {}),
    scheduledAt,
    ...(note ? { note } : {}),
  });
  await recordLeadActivity(businessId, leadId, "FOLLOW_UP_CREATED", activityBody);
  return row.id;
}

export async function executeCreateFollowUp(
  businessId: string,
  leadId: string,
  config: RuleConfig
): Promise<ActionResult> {
  const lead = await loadLead(businessId, leadId);
  if (!lead) throw new TenantNotFound();
  if (lead.archivedAt) return { status: "SKIPPED", detail: "Lead is archived." };
  const scheduledAt = new Date(Date.now() + config.followUpDelayMinutes * 60_000).toISOString();
  const note = config.note ?? "Automated follow-up.";
  const assignee = lead.assignedTo;
  await insertFollowUp(businessId, lead.id, assignee, scheduledAt, note, `Scheduled by automation for ${scheduledAt}.`);
  return { status: "SUCCESS", detail: `Follow-up scheduled for ${scheduledAt}.` };
}

export async function executeCreateReminder(
  businessId: string,
  leadId: string,
  config: RuleConfig
): Promise<ActionResult> {
  const lead = await loadLead(businessId, leadId);
  if (!lead) throw new TenantNotFound();
  if (lead.archivedAt) return { status: "SKIPPED", detail: "Lead is archived." };
  const scheduledAt = new Date(Date.now() + config.reminderDelayMinutes * 60_000).toISOString();
  const note = `[Reminder] ${config.note ?? "No contact yet — reach out to this lead."}`;
  await insertFollowUp(
    businessId,
    lead.id,
    lead.assignedTo,
    scheduledAt,
    note,
    `Reminder created by automation for ${scheduledAt}.`
  );
  return { status: "SUCCESS", detail: `Reminder scheduled for ${scheduledAt}.` };
}

async function resolveTemplate(businessId: string, leadId: string, config: RuleConfig) {
  const bid = toBusinessId(businessId);
  const templates = await WhatsAppTemplateTable.where((t) => t.businessId.eq(bid))
    .select("name", "language", "status")
    .all();
  const approved = templates.filter((t) => t.status === "APPROVED");
  if (config.templateName) {
    const match = approved.find(
      (t) => t.name === config.templateName && (!config.templateLanguage || t.language === config.templateLanguage)
    );
    if (match) return match;
    // Configured template missing/unapproved — fall through to lead selection.
  }
  const selections = await LeadTemplateSelectionTable.where((s) => s.businessId.eq(bid))
    .select("leadId", "templateName", "templateLanguage")
    .all();
  const sel = selections.find((s) => s.leadId === leadId) ?? null;
  if (sel) {
    const match = approved.find((t) => t.name === sel.templateName && t.language === sel.templateLanguage);
    if (match) return match;
  }
  return approved.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language))[0] ?? null;
}

export async function executeSendWhatsApp(
  businessId: string,
  leadId: string,
  config: RuleConfig
): Promise<ActionResult> {
  const lead = await loadLead(businessId, leadId);
  if (!lead) throw new TenantNotFound();
  if (lead.archivedAt) return { status: "SKIPPED", detail: "Lead is archived." };
  if (!lead.phone) return { status: "SKIPPED", detail: "Lead has no phone number." };
  const template = await resolveTemplate(businessId, leadId, config);
  if (!template) return { status: "SKIPPED", detail: "No approved WhatsApp template available." };
  const ctx = await systemContext(businessId);
  const message = await queueTemplateMessage(ctx, leadId, {
    templateName: template.name,
    templateLanguage: template.language,
    variables: config.variables,
  });
  return { status: "SUCCESS", detail: `Template "${template.name}" queued (message ${message.id}).` };
}

export async function executeNotifyAgent(
  businessId: string,
  leadId: string,
  ruleName: string
): Promise<ActionResult> {
  const lead = await loadLead(businessId, leadId);
  if (!lead) throw new TenantNotFound();
  if (!lead.assignedTo) return { status: "SKIPPED", detail: "Lead has no assigned agent to notify." };
  let agentLabel = lead.assignedTo;
  try {
    const user = await UserTable.where({ id: toDbId(lead.assignedTo) }).select("email", "name").first();
    if (user) agentLabel = user.name ?? user.email;
  } catch {
    // Label lookup is cosmetic — never fail the action for it.
  }
  await recordLeadActivity(
    businessId,
    lead.id,
    "NOTE_ADDED",
    `Automation "${ruleName}" notified ${agentLabel} about lead "${lead.name}".`
  );
  return { status: "SUCCESS", detail: `Notified ${agentLabel}.` };
}

export async function executeAction(
  action: AutomationAction,
  businessId: string,
  leadId: string,
  config: RuleConfig,
  ruleName: string
): Promise<ActionResult> {
  switch (action) {
    case "ASSIGN_AGENT":
      return executeAssignAgent(businessId, leadId);
    case "CREATE_FOLLOWUP":
      return executeCreateFollowUp(businessId, leadId, config);
    case "SEND_WHATSAPP":
      return executeSendWhatsApp(businessId, leadId, config);
    case "NOTIFY_AGENT":
      return executeNotifyAgent(businessId, leadId, ruleName);
    case "CREATE_REMINDER":
      return executeCreateReminder(businessId, leadId, config);
  }
}
