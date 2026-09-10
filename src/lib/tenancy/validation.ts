/**
 * Input validation for tenancy + Lead resources.
 * Framework-free: no project-local imports, unit-testable.
 */
import { isValidRole } from "./roles";

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: Record<string, string>;
}

function fail(errors: Record<string, string>): ValidationResult<never> {
  return { ok: false, errors };
}

export function validateBusinessName(input: unknown): ValidationResult<{ name: string }> {
  if (typeof input !== "object" || input === null) return fail({ name: "Business name is required." });
  const raw = (input as Record<string, unknown>)["name"];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fail({ name: "Business name is required." });
  }
  const name = raw.trim();
  if (name.length > 120) return fail({ name: "Business name must be 120 characters or fewer." });
  return { ok: true, value: { name }, errors: {} };
}

export interface CreateLeadInput {
  name: string;
  email?: string;
  phone?: string;
  status?: string;
  source?: string;
  campaignName?: string;
  adSetName?: string;
  adName?: string;
  facebookLeadId?: string;
  assignedTo?: string;
  lastContactedAt?: string;
  nextFollowUpAt?: string;
}

export const LEAD_STATUSES = ["NEW", "CONTACTED", "INTERESTED", "FOLLOW_UP", "CONVERTED", "LOST"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export function isValidLeadStatus(status: unknown): status is LeadStatus {
  return typeof status === "string" && (LEAD_STATUSES as readonly string[]).includes(status);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function optionalText(
  obj: Record<string, unknown>,
  key: string,
  max: number,
  errors: Record<string, string>
): string | undefined {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  if (raw.trim().length > max) {
    errors[key] = `${key} must be ${max} characters or fewer.`;
    return undefined;
  }
  return raw.trim();
}

function optionalDateTime(
  obj: Record<string, unknown>,
  key: string,
  errors: Record<string, string>
): string | undefined {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
    errors[key] = `${key} must be a valid ISO date-time.`;
    return undefined;
  }
  return new Date(raw).toISOString();
}

export function validateCreateLead(input: unknown): ValidationResult<CreateLeadInput> {
  if (typeof input !== "object" || input === null) return fail({ name: "Lead name is required." });
  const obj = input as Record<string, unknown>;
  const errors: Record<string, string> = {};

  const rawName = obj["name"];
  let name = "";
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    errors["name"] = "Lead name is required.";
  } else if (rawName.trim().length > 200) {
    errors["name"] = "Lead name must be 200 characters or fewer.";
  } else {
    name = rawName.trim();
  }

  let email: string | undefined;
  if (obj["email"] !== undefined && obj["email"] !== null && obj["email"] !== "") {
    if (typeof obj["email"] !== "string" || !EMAIL_RE.test(obj["email"].trim())) {
      errors["email"] = "Email is invalid.";
    } else {
      email = obj["email"].trim();
    }
  }

  let phone: string | undefined;
  if (obj["phone"] !== undefined && obj["phone"] !== null && obj["phone"] !== "") {
    if (typeof obj["phone"] !== "string" || obj["phone"].trim().length > 40) {
      errors["phone"] = "Phone must be 40 characters or fewer.";
    } else {
      phone = obj["phone"].trim();
    }
  }

  const allowedStatus = LEAD_STATUSES;
  let status: string | undefined;
  if (obj["status"] !== undefined && obj["status"] !== null && obj["status"] !== "") {
    if (!isValidLeadStatus(obj["status"])) {
      errors["status"] = `Status must be one of: ${allowedStatus.join(", ")}.`;
    } else {
      status = obj["status"];
    }
  }

  const source = optionalText(obj, "source", 120, errors);
  const campaignName = optionalText(obj, "campaignName", 200, errors);
  const adSetName = optionalText(obj, "adSetName", 200, errors);
  const adName = optionalText(obj, "adName", 200, errors);
  const facebookLeadId = optionalText(obj, "facebookLeadId", 120, errors);
  const lastContactedAt = optionalDateTime(obj, "lastContactedAt", errors);
  const nextFollowUpAt = optionalDateTime(obj, "nextFollowUpAt", errors);

  let assignedTo: string | undefined;
  if (obj["assignedTo"] !== undefined && obj["assignedTo"] !== null && obj["assignedTo"] !== "") {
    if (typeof obj["assignedTo"] !== "string" || !UUID_RE.test(obj["assignedTo"])) {
      errors["assignedTo"] = "Assignee must be a valid user id.";
    } else {
      assignedTo = obj["assignedTo"];
    }
  }

  if (Object.keys(errors).length > 0) return fail(errors);
  const value: CreateLeadInput = { name };
  if (email !== undefined) value.email = email;
  if (phone !== undefined) value.phone = phone;
  if (status !== undefined) value.status = status;
  if (source !== undefined) value.source = source;
  if (campaignName !== undefined) value.campaignName = campaignName;
  if (adSetName !== undefined) value.adSetName = adSetName;
  if (adName !== undefined) value.adName = adName;
  if (facebookLeadId !== undefined) value.facebookLeadId = facebookLeadId;
  if (assignedTo !== undefined) value.assignedTo = assignedTo;
  if (lastContactedAt !== undefined) value.lastContactedAt = lastContactedAt;
  if (nextFollowUpAt !== undefined) value.nextFollowUpAt = nextFollowUpAt;
  return { ok: true, value, errors: {} };
}

export interface UpdateLeadInput extends Partial<CreateLeadInput> {
  /** true → archive (soft-delete), false → restore. */
  archived?: boolean;
}

const NULLABLE_LEAD_KEYS = [
  "email",
  "phone",
  "source",
  "campaignName",
  "adSetName",
  "adName",
  "facebookLeadId",
  "assignedTo",
  "lastContactedAt",
  "nextFollowUpAt",
] as const;

export function validateUpdateLead(input: unknown): ValidationResult<UpdateLeadInput> {
  if (typeof input !== "object" || input === null) return fail({ _form: "Invalid payload." });
  const obj = input as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const value: UpdateLeadInput = {};

  if (obj["name"] !== undefined) {
    if (typeof obj["name"] !== "string" || obj["name"].trim().length === 0) {
      errors["name"] = "Lead name must not be empty.";
    } else if (obj["name"].trim().length > 200) {
      errors["name"] = "Lead name must be 200 characters or fewer.";
    } else {
      value.name = obj["name"].trim();
    }
  }

  // Reuse create validation for the remaining scalar fields: seed a valid
  // name so only the supplied fields can produce errors.
  const parsed = validateCreateLead({ name: "placeholder", ...obj });
  for (const key of ["status", "email", "phone", "source", "campaignName", "adSetName", "adName", "facebookLeadId", "assignedTo", "lastContactedAt", "nextFollowUpAt"] as const) {
    if (parsed.errors[key]) {
      errors[key] = parsed.errors[key];
    } else if (parsed.value?.[key] !== undefined && obj[key] !== undefined) {
      (value as Record<string, unknown>)[key] = parsed.value[key];
    }
  }

  if (obj["archived"] !== undefined) {
    if (typeof obj["archived"] !== "boolean") {
      errors["archived"] = "Archived must be true or false.";
    } else {
      value.archived = obj["archived"];
    }
  }

  // Explicit null clears optional fields.
  for (const k of NULLABLE_LEAD_KEYS) {
    if (obj[k] === null) (value as Record<string, unknown>)[k] = null;
  }

  if (Object.keys(errors).length > 0) return fail(errors);
  return { ok: true, value, errors: {} };
}

export type LeadSortField = "createdAt" | "updatedAt" | "name" | "status" | "nextFollowUpAt";
export type SortDirection = "asc" | "desc";

export interface LeadQuery {
  search: string;
  /** Exact status match, or "" for all. */
  status: string;
  /** "me" | "unassigned" | user UUID | "" for all. */
  assignee: string;
  /** "active" (default) | "archived" | "all". */
  archived: "active" | "archived" | "all";
  sort: LeadSortField;
  dir: SortDirection;
  page: number;
  pageSize: number;
}

const SORT_FIELDS: readonly string[] = ["createdAt", "updatedAt", "name", "status", "nextFollowUpAt"];

/** Validate list query params (URL search params or API query). All optional. */
export function validateLeadQuery(input: Record<string, string | string[] | undefined>): LeadQuery {
  const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

  const search = first(input["search"]).slice(0, 200);
  const statusRaw = first(input["status"]);
  const status = statusRaw === "" || statusRaw === "all" || isValidLeadStatus(statusRaw) ? statusRaw : "";

  const assigneeRaw = first(input["assignee"]);
  const assignee =
    assigneeRaw === "" || assigneeRaw === "all" || assigneeRaw === "me" || assigneeRaw === "unassigned" || UUID_RE.test(assigneeRaw)
      ? assigneeRaw
      : "";

  const archivedRaw = first(input["archived"]);
  const archived: LeadQuery["archived"] =
    archivedRaw === "archived" || archivedRaw === "all" ? archivedRaw : "active";

  const sort: LeadSortField = (SORT_FIELDS as readonly string[]).includes(first(input["sort"]))
    ? (first(input["sort"]) as LeadSortField)
    : "createdAt";
  const dir: SortDirection = first(input["dir"]) === "asc" ? "asc" : "desc";

  const pageNum = Number.parseInt(first(input["page"]), 10);
  const sizeNum = Number.parseInt(first(input["pageSize"]), 10);
  const page = Number.isFinite(pageNum) && pageNum >= 1 ? Math.min(pageNum, 10000) : 1;
  const pageSize = Number.isFinite(sizeNum) && sizeNum >= 1 ? Math.min(sizeNum, 100) : 20;

  return { search, status, assignee, archived, sort, dir, page, pageSize };
}

export function validateMemberRole(input: unknown): ValidationResult<{ role: string }> {
  if (typeof input !== "object" || input === null) return fail({ role: "Role is required." });
  const role = (input as Record<string, unknown>)["role"];
  if (!isValidRole(role)) return fail({ role: "Role must be one of: OWNER, ADMIN, SALES." });
  return { ok: true, value: { role }, errors: {} };
}

export const LEAD_ACTIVITY_TYPES = [
  "CREATED",
  "ASSIGNED",
  "STATUS_CHANGED",
  "NOTE_ADDED",
  "FOLLOW_UP_CREATED",
  "FOLLOW_UP_COMPLETED",
  "WHATSAPP_SENT",
  "WHATSAPP_RECEIVED",
] as const;
export type LeadActivityType = (typeof LEAD_ACTIVITY_TYPES)[number];

export function isValidLeadActivityType(type: unknown): type is LeadActivityType {
  return typeof type === "string" && (LEAD_ACTIVITY_TYPES as readonly string[]).includes(type);
}

// In-app notification catalog lives in its own import-free module so unit
// tests can exercise it directly; re-exported here for convenience.
export {
  NOTIFICATION_AUDIENCE,
  NOTIFICATION_TYPES,
  isValidNotificationType,
  validateNotificationQuery,
  type NotificationListQuery,
  type NotificationType,
} from "./notification-catalog";

export interface CreateLeadNoteInput {
  body: string;
}

export function validateLeadNote(input: unknown): ValidationResult<CreateLeadNoteInput> {
  if (typeof input !== "object" || input === null) return fail({ body: "Note is required." });
  const raw = (input as Record<string, unknown>)["body"];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fail({ body: "Note must not be empty." });
  }
  const body = raw.trim();
  if (body.length > 2000) return fail({ body: "Note must be 2000 characters or fewer." });
  return { ok: true, value: { body }, errors: {} };
}

export interface LogLeadActivityInput {
  type: string;
  body?: string;
}

export function validateLogLeadActivity(input: unknown): ValidationResult<LogLeadActivityInput> {
  if (typeof input !== "object" || input === null) return fail({ type: "Activity type is required." });
  const obj = input as Record<string, unknown>;
  const errors: Record<string, string> = {};
  let type = "";
  if (!isValidLeadActivityType(obj["type"])) {
    errors["type"] = `Type must be one of: ${LEAD_ACTIVITY_TYPES.join(", ")}.`;
  } else {
    type = obj["type"];
  }
  let body: string | undefined;
  const rawBody = obj["body"];
  if (rawBody !== undefined && rawBody !== null && rawBody !== "") {
    if (typeof rawBody !== "string" || rawBody.trim().length === 0) {
      body = undefined;
    } else if (rawBody.trim().length > 2000) {
      errors["body"] = "Body must be 2000 characters or fewer.";
    } else {
      body = rawBody.trim();
    }
  }
  if (Object.keys(errors).length > 0) return fail(errors);
  const value: LogLeadActivityInput = { type };
  if (body !== undefined) value.body = body;
  return { ok: true, value, errors: {} };
}

export type ActivitySortOrder = "asc" | "desc";

export interface ActivityQuery {
  type: string;
  order: ActivitySortOrder;
  limit: number;
}

/** Validate timeline query params. All optional; unknown types match nothing. */
export function validateActivityQuery(
  input: Record<string, string | string[] | undefined>
): ActivityQuery {
  const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
  const typeRaw = first(input["type"]);
  const type =
    typeRaw === "" || typeRaw === "all" || isValidLeadActivityType(typeRaw) ? typeRaw : "";
  const order: ActivitySortOrder = first(input["order"]) === "asc" ? "asc" : "desc";
  const limitNum = Number.parseInt(first(input["limit"]), 10);
  const limit = Number.isFinite(limitNum) && limitNum >= 1 ? Math.min(limitNum, 200) : 100;
  return { type, order, limit };
}

export const FOLLOW_UP_STATUSES = ["PENDING", "COMPLETED", "CANCELLED"] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

/**
 * Effective display status. OVERDUE is derived (PENDING with scheduledAt in
 * the past) — it is never stored, so no cron is needed to surface overdue
 * items, and writes of OVERDUE are rejected.
 */
export type FollowUpEffectiveStatus = FollowUpStatus | "OVERDUE";

export function isValidFollowUpStatus(status: unknown): status is FollowUpStatus {
  return typeof status === "string" && (FOLLOW_UP_STATUSES as readonly string[]).includes(status);
}

export function followUpEffectiveStatus(stored: string, scheduledAt: string, nowMs = Date.now()): FollowUpEffectiveStatus {
  if (stored === "PENDING" && new Date(scheduledAt).getTime() < nowMs) return "OVERDUE";
  return (isValidFollowUpStatus(stored) ? stored : "PENDING") as FollowUpEffectiveStatus;
}

export interface CreateFollowUpInput {
  scheduledAt: string;
  note?: string;
  assignedTo?: string;
}

export function validateCreateFollowUp(input: unknown): ValidationResult<CreateFollowUpInput> {
  if (typeof input !== "object" || input === null) return fail({ scheduledAt: "Scheduled time is required." });
  const obj = input as Record<string, unknown>;
  const errors: Record<string, string> = {};

  let scheduledAt = "";
  const iso = optionalDateTime(obj, "scheduledAt", errors);
  if (iso === undefined && !errors["scheduledAt"]) {
    errors["scheduledAt"] = "Scheduled time is required.";
  } else if (iso !== undefined) {
    scheduledAt = iso;
  }

  const note = optionalText(obj, "note", 2000, errors);

  let assignedTo: string | undefined;
  if (obj["assignedTo"] !== undefined && obj["assignedTo"] !== null && obj["assignedTo"] !== "") {
    if (typeof obj["assignedTo"] !== "string" || !UUID_RE.test(obj["assignedTo"])) {
      errors["assignedTo"] = "Assignee must be a valid user id.";
    } else {
      assignedTo = obj["assignedTo"];
    }
  }

  if (obj["status"] !== undefined && obj["status"] !== "PENDING") {
    errors["status"] = "New follow-ups always start as PENDING.";
  }

  if (Object.keys(errors).length > 0) return fail(errors);
  const value: CreateFollowUpInput = { scheduledAt };
  if (note !== undefined) value.note = note;
  if (assignedTo !== undefined) value.assignedTo = assignedTo;
  return { ok: true, value, errors: {} };
}

export interface UpdateFollowUpInput {
  scheduledAt?: string;
  note?: string | null;
  /** PENDING→COMPLETED|CANCELLED, COMPLETED|CANCELLED→PENDING (reopen). */
  status?: FollowUpStatus;
}

export function validateUpdateFollowUp(input: unknown): ValidationResult<UpdateFollowUpInput> {
  if (typeof input !== "object" || input === null) return fail({ _form: "Invalid payload." });
  const obj = input as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const value: UpdateFollowUpInput = {};

  if (obj["scheduledAt"] !== undefined) {
    const iso = optionalDateTime(obj, "scheduledAt", errors);
    if (iso !== undefined) value.scheduledAt = iso;
    else if (!errors["scheduledAt"]) errors["scheduledAt"] = "Scheduled time must be a valid ISO date-time.";
  }
  if (obj["note"] !== undefined) {
    if (obj["note"] === null) {
      value.note = null;
    } else {
      const note = optionalText(obj, "note", 2000, errors);
      if (note !== undefined) value.note = note;
    }
  }
  if (obj["status"] !== undefined) {
    if (!isValidFollowUpStatus(obj["status"])) {
      errors["status"] = `Status must be one of: ${FOLLOW_UP_STATUSES.join(", ")}. OVERDUE is derived automatically.`;
    } else {
      value.status = obj["status"];
    }
  }
  if (obj["assignedTo"] !== undefined) {
    errors["assignedTo"] = "Reassign via a new follow-up; assignees are immutable.";
  }

  if (Object.keys(errors).length > 0) return fail(errors);
  if (Object.keys(value).length === 0 && !errors["_form"]) return fail({ _form: "Nothing to update." });
  return { ok: true, value, errors: {} };
}

export type FollowUpScope = "all" | "upcoming" | "today" | "overdue" | "mine";

export interface FollowUpQuery {
  scope: FollowUpScope;
  status: string;
  leadId: string;
  assignee: string;
  page: number;
  pageSize: number;
}

/** Validate workspace follow-up query params. All optional. */
export function validateFollowUpQuery(input: Record<string, string | string[] | undefined>): FollowUpQuery {
  const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
  const scopeRaw = first(input["scope"]);
  const scope: FollowUpScope =
    scopeRaw === "upcoming" || scopeRaw === "today" || scopeRaw === "overdue" || scopeRaw === "mine" ? scopeRaw : "all";
  const statusRaw = first(input["status"]);
  const status = statusRaw === "" || statusRaw === "all" || isValidFollowUpStatus(statusRaw) ? statusRaw : "";
  const leadRaw = first(input["leadId"]);
  const leadId = leadRaw === "" || UUID_RE.test(leadRaw) ? leadRaw : "";
  const assigneeRaw = first(input["assignee"]);
  const assignee =
    assigneeRaw === "" || assigneeRaw === "all" || assigneeRaw === "me" || assigneeRaw === "unassigned" || UUID_RE.test(assigneeRaw)
      ? assigneeRaw
      : "";
  const pageNum = Number.parseInt(first(input["page"]), 10);
  const sizeNum = Number.parseInt(first(input["pageSize"]), 10);
  const page = Number.isFinite(pageNum) && pageNum >= 1 ? Math.min(pageNum, 10000) : 1;
  const pageSize = Number.isFinite(sizeNum) && sizeNum >= 1 ? Math.min(sizeNum, 100) : 20;
  return { scope, status, leadId, assignee, page, pageSize };
}

// Analytics filter validation lives in the import-free core module (so unit
// tests can exercise it directly); re-exported here for route/page parity
// with the other validators.
export {
  ANALYTICS_DATE_PRESETS,
  ANALYTICS_DEFAULT_DAYS,
  ANALYTICS_MAX_DAYS,
  validateAnalyticsQuery,
  type AnalyticsQuery,
} from "./analytics-core";
