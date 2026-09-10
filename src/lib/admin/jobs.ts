/**
 * Platform automation job + log browsers (super-admin only).
 *
 * Read-only: retries stay on the tenant-scoped job routes so the audit
 * trail keeps a workspace actor. Reads bypass membership — authorization
 * comes from `requireSuperAdmin` — and always carry the business name for
 * context.
 */
import { AutomationJobTable, AutomationLogTable, BusinessTable } from "../../prisma/tables";
import { toBusinessId, toDbId } from "../tenancy/businesses";

export type JobStatusFilter = "all" | "QUEUED" | "SENDING" | "DONE" | "FAILED";
export type LogStatusFilter = "all" | "SUCCESS" | "FAILED" | "SKIPPED";

export interface AdminJobRow {
  id: string;
  businessId: string;
  businessName: string | null;
  trigger: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminJobPage {
  jobs: AdminJobRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AdminLogRow {
  id: string;
  businessId: string;
  businessName: string | null;
  trigger: string;
  action: string;
  status: string;
  detail: string | null;
  createdAt: string;
}

export interface AdminLogPage {
  logs: AdminLogRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const JOB_FIELDS = ["id", "businessId", "trigger", "status", "attempts", "lastError", "createdAt", "updatedAt"] as const;
const LOG_FIELDS = ["id", "businessId", "trigger", "action", "status", "detail", "createdAt"] as const;

async function businessNameOf(businessId: string): Promise<string | null> {
  try {
    const row = await BusinessTable.where({ id: toDbId(businessId) })
      .select("id", "name")
      .first();
    return row && row.id === businessId ? row.name : null;
  } catch {
    return null;
  }
}

function normalizeStatus(value: unknown, allowed: readonly string[]): string {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value : "all";
}

function paginate<T>(items: T[], page: number | undefined, pageSize: number | undefined): {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
} {
  const safeSize = Number.isFinite(pageSize) && (pageSize as number) >= 1 ? Math.min(100, Math.floor(pageSize as number)) : 20;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const safePage = Number.isFinite(page) && (page as number) >= 1 ? Math.min(Math.floor(page as number), totalPages) : 1;
  return {
    items: items.slice((safePage - 1) * safeSize, safePage * safeSize),
    total,
    page: safePage,
    pageSize: safeSize,
    totalPages,
  };
}

/** Platform job browser. `status` narrows; `businessId` scopes (malformed → empty). */
export async function listJobsAdmin(query?: {
  status?: unknown;
  businessId?: string;
  page?: number;
  pageSize?: number;
}): Promise<AdminJobPage> {
  const status = normalizeStatus(query?.status, ["QUEUED", "SENDING", "DONE", "FAILED"]);
  let scopedBusiness: string | null = null;
  if (query?.businessId) {
    try {
      scopedBusiness = toBusinessId(query.businessId);
    } catch {
      return { jobs: [], total: 0, page: 1, pageSize: 20, totalPages: 1 };
    }
  }
  const rows = await AutomationJobTable.select(...JOB_FIELDS).all();
  const matched = rows
    .filter((r) => (status === "all" || r.status === status) && (!scopedBusiness || r.businessId === query?.businessId))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const page = paginate(matched, query?.page, query?.pageSize);
  const jobs: AdminJobRow[] = [];
  for (const r of page.items) {
    jobs.push({
      id: r.id,
      businessId: r.businessId,
      businessName: await businessNameOf(r.businessId),
      trigger: r.trigger,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  }
  return { jobs, total: page.total, page: page.page, pageSize: page.pageSize, totalPages: page.totalPages };
}

/** Platform automation-log browser. Same scoping rules as jobs. */
export async function listLogsAdmin(query?: {
  status?: unknown;
  businessId?: string;
  page?: number;
  pageSize?: number;
}): Promise<AdminLogPage> {
  const status = normalizeStatus(query?.status, ["SUCCESS", "FAILED", "SKIPPED"]);
  let scopedBusiness: string | null = null;
  if (query?.businessId) {
    try {
      scopedBusiness = toBusinessId(query.businessId);
    } catch {
      return { logs: [], total: 0, page: 1, pageSize: 20, totalPages: 1 };
    }
  }
  const rows = await AutomationLogTable.select(...LOG_FIELDS).all();
  const matched = rows
    .filter((r) => (status === "all" || r.status === status) && (!scopedBusiness || r.businessId === query?.businessId))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const page = paginate(matched, query?.page, query?.pageSize);
  const logs: AdminLogRow[] = [];
  for (const r of page.items) {
    logs.push({
      id: r.id,
      businessId: r.businessId,
      businessName: await businessNameOf(r.businessId),
      trigger: r.trigger,
      action: r.action,
      status: r.status,
      detail: r.detail,
      createdAt: r.createdAt,
    });
  }
  return { logs, total: page.total, page: page.page, pageSize: page.pageSize, totalPages: page.totalPages };
}
