/**
 * Facebook Page + Lead Form selection — the layer between the workspace and
 * Meta's Pages/Lead Ads edges.
 *
 * Security contract (same as service.ts):
 * - Page access tokens are decrypted function-locally, used for a single
 *   server-to-server call, and stored only as AES-256-GCM ciphertext.
 *   They never appear in DTOs, responses, logs, or errors.
 * - Stored rows carry the minimum metadata Meta exposes for later steps:
 *   page id/name/tasks (+ encrypted token, required for form listing and
 *   webhook subscription), form id/page/name/status.
 * - Listing/selecting/connecting pages and forms requires
 *   `businesses.update` (OWNER/ADMIN) — ad assets are workspace-managed.
 *   Reads of the persisted selection ride on workspace membership via
 *   BusinessContext (route guards).
 */
import { MetaFormTable, MetaPageTable } from "../../../prisma/tables";
import { env } from "../../env";
import type { BusinessContext } from "../../tenancy/context";
import { requirePermission, TenantConflict, TenantNotFound } from "../../tenancy/policies";
import { toBusinessId, toDbId } from "../../tenancy/businesses";
import { decryptToken, encryptToken } from "./crypto";
import { MetaGraphClient, type MetaLeadFormInfo, type MetaPageInfo } from "./client";
import {
  pickConnectableForm,
  pickSelectablePage,
  SelectionConflict,
  SelectionNotFound,
  toAvailableForms,
  toAvailablePages,
  type AvailableForm,
  type AvailablePage,
} from "./selection-rules";
import { getDecryptedMetaToken, META_MANAGE_PERMISSION } from "./service";

export interface SelectedPage {
  metaPageId: string;
  name: string;
  tasks: string[];
  selectedAt: string | null;
}

export interface ConnectedForm {
  metaFormId: string;
  metaPageId: string;
  name: string;
  status: string;
  connectedAt: string | null;
}

export interface MetaSelection {
  page: SelectedPage | null;
  form: ConnectedForm | null;
}

interface StoredPage {
  id: string;
  businessId: string;
  metaPageId: string;
  name: string;
  pageTokenEncrypted: string;
  tasks: string;
  selectedAt: string | null;
}

interface StoredForm {
  id: string;
  businessId: string;
  metaPageId: string;
  metaFormId: string;
  name: string;
  status: string;
  connectedAt: string | null;
}

const PAGE_FIELDS = [
  "id",
  "businessId",
  "metaPageId",
  "name",
  "pageTokenEncrypted",
  "tasks",
  "selectedAt",
  "createdAt",
  "updatedAt",
] as const;

const FORM_FIELDS = [
  "id",
  "businessId",
  "metaPageId",
  "metaFormId",
  "name",
  "status",
  "connectedAt",
  "createdAt",
  "updatedAt",
] as const;

function defaultClient(): MetaGraphClient {
  const baseUrl = env.metaGraphBaseUrl;
  return new MetaGraphClient(baseUrl ? { baseUrl } : undefined);
}

async function storedPages(businessId: string): Promise<StoredPage[]> {
  const bid = toBusinessId(businessId);
  const rows = await MetaPageTable.where((m) => m.businessId.eq(bid))
    .select(...PAGE_FIELDS)
    .all();
  return rows.map((row) => ({
    id: row.id,
    businessId: row.businessId,
    metaPageId: row.metaPageId,
    name: row.name,
    pageTokenEncrypted: row.pageTokenEncrypted,
    tasks: row.tasks,
    selectedAt: row.selectedAt,
  }));
}

async function storedForms(businessId: string): Promise<StoredForm[]> {
  const bid = toBusinessId(businessId);
  const rows = await MetaFormTable.where((m) => m.businessId.eq(bid))
    .select(...FORM_FIELDS)
    .all();
  return rows.map((row) => ({
    id: row.id,
    businessId: row.businessId,
    metaPageId: row.metaPageId,
    metaFormId: row.metaFormId,
    name: row.name,
    status: row.status,
    connectedAt: row.connectedAt,
  }));
}

export type { AvailableForm, AvailablePage };

/**
 * Translate pure selection failures to the tenancy errors so HTTP mappings
 * stay identical (404 unknown, 409 precondition).
 */
function throwTenant(err: unknown): never {
  if (err instanceof SelectionNotFound) throw new TenantNotFound(err.message);
  if (err instanceof SelectionConflict) throw new TenantConflict(err.message);
  throw err;
}

function pickPage(pages: MetaPageInfo[], metaPageId: string) {
  try {
    return pickSelectablePage(pages, metaPageId);
  } catch (err) {
    throwTenant(err);
  }
}

function pickForm(forms: MetaLeadFormInfo[], metaFormId: string) {
  try {
    return pickConnectableForm(forms, metaFormId);
  } catch (err) {
    throwTenant(err);
  }
}

/**
 * Available Pages from Meta merged with persisted selection. Page tokens
 * are dropped before return — selection re-reads them from storage.
 */
export async function listAvailablePages(
  context: BusinessContext,
  client?: MetaGraphClient
): Promise<AvailablePage[]> {
  requirePermission(context, META_MANAGE_PERMISSION);
  const token = await getDecryptedMetaToken(context);
  if (!token) throw new TenantNotFound("No active Meta connection.");
  const live: MetaPageInfo[] = await (client ?? defaultClient()).listPages(token);
  const stored = await storedPages(context.business.id);
  const selectedById = new Set(stored.filter((s) => s.selectedAt).map((s) => s.metaPageId));
  return toAvailablePages(live, selectedById);
}

/**
 * Select a Page: re-reads it live from Meta (so names/tasks are fresh),
 * requires the ADVERTISE/MANAGE task and a Page token, persists the
 * encrypted token + metadata, and marks it the single selected Page.
 */
export async function selectMetaPage(
  context: BusinessContext,
  metaPageId: string,
  client?: MetaGraphClient
): Promise<SelectedPage> {
  requirePermission(context, META_MANAGE_PERMISSION);
  const token = await getDecryptedMetaToken(context);
  if (!token) throw new TenantNotFound("No active Meta connection.");
  const live = await (client ?? defaultClient()).listPages(token);
  const match = pickPage(live, metaPageId);

  const businessId = toBusinessId(context.business.id);
  const now = new Date().toISOString();
  const encrypted = await encryptToken(match.pageToken, env.metaTokenKey);
  const tasks = match.tasks.join(" ");

  // Upsert the row, then make it the single selected Page.
  const existing = (await storedPages(context.business.id)).find((s) => s.metaPageId === match.id);
  if (existing) {
    await MetaPageTable.where({ id: toDbId(existing.id) }).update({
      name: match.name,
      pageTokenEncrypted: encrypted,
      tasks,
      selectedAt: now,
    } as never);
  } else {
    await MetaPageTable.select("id").create({
      businessId,
      metaPageId: match.id,
      name: match.name,
      pageTokenEncrypted: encrypted,
      tasks,
      selectedAt: now,
    });
  }
  const rest = (await storedPages(context.business.id)).filter((s) => s.metaPageId !== match.id && s.selectedAt);
  for (const row of rest) {
    await MetaPageTable.where({ id: toDbId(row.id) }).update({ selectedAt: null } as never);
  }
  return { metaPageId: match.id, name: match.name, tasks: match.tasks, selectedAt: now };
}

async function requireSelectedPage(context: BusinessContext): Promise<StoredPage> {
  const rows = await storedPages(context.business.id);
  const selected = rows.find((r) => r.selectedAt) ?? null;
  if (!selected) throw new TenantConflict("Select a Page first.");
  return selected;
}

async function decryptPageToken(row: StoredPage): Promise<string> {
  return decryptToken(row.pageTokenEncrypted, env.metaTokenKey);
}

/**
 * Lead forms on the selected Page, merged with the persisted connected
 * form. No form rows are written here — connecting persists.
 */
export async function listLeadForms(
  context: BusinessContext,
  client?: MetaGraphClient
): Promise<{ page: SelectedPage; forms: AvailableForm[] }> {
  requirePermission(context, META_MANAGE_PERMISSION);
  const selected = await requireSelectedPage(context);
  const pageToken = await decryptPageToken(selected);
  const live: MetaLeadFormInfo[] = await (client ?? defaultClient()).listLeadForms({
    pageId: selected.metaPageId,
    pageToken,
  });
  const connected = await storedForms(context.business.id);
  const connectedById = new Set(connected.map((f) => f.metaFormId));
  return {
    page: {
      metaPageId: selected.metaPageId,
      name: selected.name,
      tasks: selected.tasks.split(" ").filter(Boolean),
      selectedAt: selected.selectedAt,
    },
    forms: toAvailableForms(live, connectedById),
  };
}

/**
 * Connect a lead form: must exist on the selected Page and be ACTIVE
 * (Meta only delivers webhooks for active forms). Replaces any previously
 * connected form — one connected form per business.
 */
export async function connectLeadForm(
  context: BusinessContext,
  metaFormId: string,
  client?: MetaGraphClient
): Promise<ConnectedForm> {
  requirePermission(context, META_MANAGE_PERMISSION);
  const selected = await requireSelectedPage(context);
  const pageToken = await decryptPageToken(selected);
  const live = await (client ?? defaultClient()).listLeadForms({
    pageId: selected.metaPageId,
    pageToken,
  });
  const match = pickForm(live, metaFormId);

  const businessId = toBusinessId(context.business.id);
  const now = new Date().toISOString();
  // Single connected form per business: drop the previous one first.
  const previous = await storedForms(context.business.id);
  for (const row of previous) {
    await MetaFormTable.where({ id: toDbId(row.id) }).delete();
  }
  await MetaFormTable.select("id").create({
    businessId,
    metaPageId: selected.metaPageId,
    metaFormId: match.id,
    name: match.name,
    status: match.status,
    connectedAt: now,
  });
  return {
    metaFormId: match.id,
    metaPageId: selected.metaPageId,
    name: match.name,
    status: match.status,
    connectedAt: now,
  };
}

/** Disconnect the connected form. Webhook delivery setup stays out of scope. */
export async function disconnectLeadForm(context: BusinessContext): Promise<boolean> {
  requirePermission(context, META_MANAGE_PERMISSION);
  const rows = await storedForms(context.business.id);
  if (rows.length === 0) return false;
  for (const row of rows) {
    await MetaFormTable.where({ id: toDbId(row.id) }).delete();
  }
  return true;
}

/** Persisted selection for UI/API: selected Page + connected form, redacted. */
export async function getMetaSelection(context: BusinessContext): Promise<MetaSelection> {
  const [pages, forms] = await Promise.all([
    storedPages(context.business.id),
    storedForms(context.business.id),
  ]);
  const page = pages.find((p) => p.selectedAt) ?? null;
  const form = forms[0] ?? null;
  return {
    page: page
      ? {
          metaPageId: page.metaPageId,
          name: page.name,
          tasks: page.tasks.split(" ").filter(Boolean),
          selectedAt: page.selectedAt,
        }
      : null,
    form: form
      ? {
          metaFormId: form.metaFormId,
          metaPageId: form.metaPageId,
          name: form.name,
          status: form.status,
          connectedAt: form.connectedAt,
        }
      : null,
  };
}
