/**
 * WhatsApp message template management — cached catalog + per-lead
 * selection. No sending (automated follow-up is explicitly out of scope).
 *
 * Security contract (mirrors the connection service):
 * - Template sync and selection management require `businesses.update`
 *   (OWNER/ADMIN). Listing and picking a template for a lead require
 *   `leads.update`, so SALES agents can use templates in their workflow.
 * - Reads/writes always filter by the context `businessId`; lead ids
 *   resolve inside the workspace (unknown/foreign → 404, no oracle).
 * - Only APPROVED templates may be selected for sending, per Meta's
 *   template policy. Statuses of anything else are display-only.
 */
import { LeadTemplateSelectionTable, WhatsAppConnectionTable, WhatsAppTemplateTable } from "../../../prisma/tables";
import { env } from "../../env";
import type { BusinessContext } from "../../tenancy/context";
import { requirePermission, TenantConflict, TenantNotFound } from "../../tenancy/policies";
import { toBusinessId, toDbId } from "../../tenancy/businesses";
import { getLead } from "../../tenancy/leads";
import { decryptToken } from "../meta/crypto";
import { WHATSAPP_MANAGE_PERMISSION } from "./service";
import { WhatsAppCloudClient, type WaMessageTemplate } from "./client";
import { extractVariables, type TemplateVariable } from "./template-parse";

export interface TemplateDTO {
  name: string;
  language: string;
  category: string | null;
  status: string;
  sendable: boolean;
  variables: TemplateVariable[];
  components: Array<{ type: string; format?: string; text?: string }>;
  updatedAt: string;
}

export interface LeadTemplateSelectionDTO {
  templateName: string;
  templateLanguage: string;
  status: string;
  variables: TemplateVariable[];
  selectedBy: string;
  updatedAt: string;
}

interface StoredTemplate {
  id: string;
  businessId: string;
  wabaId: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  componentsJson: string;
  updatedAt: string;
}

const TEMPLATE_FIELDS = [
  "id",
  "businessId",
  "wabaId",
  "name",
  "language",
  "category",
  "status",
  "componentsJson",
  "updatedAt",
] as const;

function defaultClient(): WhatsAppCloudClient {
  const baseUrl = env.metaGraphBaseUrl;
  return new WhatsAppCloudClient(baseUrl ? { baseUrl } : undefined);
}

function parseComponents(json: string): Array<{ type: string; format?: string; text?: string }> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((c): Array<{ type: string; format?: string; text?: string }> => {
      if (!c || typeof c !== "object") return [];
      const cr = c as Record<string, unknown>;
      if (typeof cr["type"] !== "string") return [];
      const out: { type: string; format?: string; text?: string } = { type: cr["type"] };
      if (typeof cr["format"] === "string") out.format = cr["format"];
      if (typeof cr["text"] === "string") out.text = cr["text"];
      return [out];
    });
  } catch {
    return [];
  }
}

function toDTO(row: StoredTemplate): TemplateDTO {
  const components = parseComponents(row.componentsJson);
  return {
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    sendable: row.status === "APPROVED",
    variables: extractVariables(components),
    components,
    updatedAt: row.updatedAt,
  };
}

async function requireConnection(context: BusinessContext): Promise<{ wabaId: string; token: string }> {
  const bid = toBusinessId(context.business.id);
  const row = await WhatsAppConnectionTable.where((m) => m.businessId.eq(bid))
    .select("wabaId", "accessTokenEncrypted", "status")
    .first();
  if (!row || row.status !== "ACTIVE") throw new TenantNotFound("No active WhatsApp connection.");
  let token: string;
  try {
    token = await decryptToken(row.accessTokenEncrypted, env.metaTokenKey);
  } catch {
    throw new TenantConflict("Stored credentials are unreadable. Reconnect WhatsApp.");
  }
  return { wabaId: row.wabaId, token };
}

async function storedTemplates(businessId: string): Promise<StoredTemplate[]> {
  const bid = toBusinessId(businessId);
  const rows = await WhatsAppTemplateTable.where((m) => m.businessId.eq(bid))
    .select(...TEMPLATE_FIELDS)
    .all();
  return rows.map((row) => ({
    id: row.id,
    businessId: row.businessId,
    wabaId: row.wabaId,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    componentsJson: row.componentsJson,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Sync the cached catalog from Meta: upsert every returned template,
 * prune rows Meta no longer lists. Requires businesses.update.
 */
export async function syncTemplates(
  context: BusinessContext,
  client?: WhatsAppCloudClient
): Promise<{ synced: number; pruned: number }> {
  requirePermission(context, WHATSAPP_MANAGE_PERMISSION);
  const { wabaId, token } = await requireConnection(context);
  let live: WaMessageTemplate[];
  try {
    live = await (client ?? defaultClient()).listMessageTemplates({ wabaId, token });
  } catch (err) {
    throw new TenantConflict(
      err instanceof Error ? `Template sync failed: ${err.message}` : "Template sync failed."
    );
  }
  const businessId = toBusinessId(context.business.id);
  const seen = new Set<string>();
  let synced = 0;
  for (const t of live) {
    const key = `${t.name}\u0000${t.language}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const componentsJson = JSON.stringify(
      t.components.map((c) => ({
        type: c.type,
        ...(c.format !== undefined ? { format: c.format } : {}),
        ...(c.text !== undefined ? { text: c.text } : {}),
      }))
    );
    const existing = (await storedTemplates(context.business.id)).find(
      (s) => s.name === t.name && s.language === t.language
    );
    if (existing) {
      await WhatsAppTemplateTable.where({ id: toDbId(existing.id) }).update({
        wabaId,
        category: t.category,
        status: t.status,
        componentsJson,
      } as never);
    } else {
      await WhatsAppTemplateTable.select("id").create({
        businessId,
        wabaId,
        name: t.name,
        language: t.language,
        ...(t.category !== null ? { category: t.category } : {}),
        status: t.status,
        componentsJson,
      });
    }
    synced += 1;
  }
  let pruned = 0;
  for (const stored of await storedTemplates(context.business.id)) {
    if (!seen.has(`${stored.name}\u0000${stored.language}`)) {
      await WhatsAppTemplateTable.where({ id: toDbId(stored.id) }).delete();
      pruned += 1;
    }
  }
  return { synced, pruned };
}

/** Cached catalog for pickers and review. Requires leads.read (defense in depth, not route-only). */
export async function listTemplates(context: BusinessContext): Promise<TemplateDTO[]> {
  requirePermission(context, "leads.read");
  const rows = await storedTemplates(context.business.id);
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
  return rows.map(toDTO);
}

/**
 * Select an APPROVED template for a lead. Requires leads.update (SALES
 * included). Unknown templates → 404; non-APPROVED → 409. Replaces any
 * previous selection for the lead.
 */
export async function selectTemplateForLead(
  context: BusinessContext,
  leadId: string,
  input: { name: string; language: string }
): Promise<LeadTemplateSelectionDTO> {
  requirePermission(context, "leads.update");
  const lead = await getLead(context, leadId);
  if (!lead) throw new TenantNotFound();
  const template = (await storedTemplates(context.business.id)).find(
    (s) => s.name === input.name && s.language === input.language
  );
  if (!template) throw new TenantNotFound("Template not found. Sync templates first.");
  if (template.status !== "APPROVED") {
    throw new TenantConflict("Only APPROVED templates can be selected for sending.");
  }
  const businessId = toBusinessId(context.business.id);
  const prior = await LeadTemplateSelectionTable.where((s) => s.businessId.eq(businessId))
    .select("id", "leadId")
    .all()
    .then((rows) => rows.find((r) => r.leadId === lead.id) ?? null);

  if (prior) {
    await LeadTemplateSelectionTable.where({ id: toDbId(prior.id) }).update({
      templateName: template.name,
      templateLanguage: template.language,
      selectedBy: toDbId(context.membership.userId),
    } as never);
  } else {
    await LeadTemplateSelectionTable.select("id").create({
      businessId,
      leadId: toDbId(lead.id),
      templateName: template.name,
      templateLanguage: template.language,
      selectedBy: toDbId(context.membership.userId),
    });
  }
  const current = await getLeadTemplateSelection(context, lead.id);
  if (!current) throw new TenantNotFound();
  return current;
}

/** Current selection for a lead, with live template snapshot (or null). */
export async function getLeadTemplateSelection(
  context: BusinessContext,
  leadId: string
): Promise<LeadTemplateSelectionDTO | null> {
  const lead = await getLead(context, leadId);
  if (!lead) throw new TenantNotFound();
  const businessId = toBusinessId(context.business.id);
  const rows = await LeadTemplateSelectionTable.where((s) => s.businessId.eq(businessId))
    .select("id", "leadId", "templateName", "templateLanguage", "selectedBy", "updatedAt")
    .all();
  const match = rows.find((r) => r.leadId === lead.id) ?? null;
  if (!match) return null;
  const template = (await storedTemplates(context.business.id)).find(
    (s) => s.name === match.templateName && s.language === match.templateLanguage
  );
  const dto = template ? toDTO(template) : null;
  return {
    templateName: match.templateName,
    templateLanguage: match.templateLanguage,
    status: dto?.status ?? "UNKNOWN",
    variables: dto?.variables ?? [],
    selectedBy: match.selectedBy,
    updatedAt: match.updatedAt,
  };
}

/** Clear a lead's template selection. Requires leads.update. */
export async function clearLeadTemplateSelection(
  context: BusinessContext,
  leadId: string
): Promise<boolean> {
  requirePermission(context, "leads.update");
  const lead = await getLead(context, leadId);
  if (!lead) throw new TenantNotFound();
  const businessId = toBusinessId(context.business.id);
  const rows = await LeadTemplateSelectionTable.where((s) => s.businessId.eq(businessId))
    .select("id", "leadId")
    .all();
  const match = rows.find((r) => r.leadId === lead.id) ?? null;
  if (!match) return false;
  await LeadTemplateSelectionTable.where({ id: toDbId(match.id) }).delete();
  return true;
}
