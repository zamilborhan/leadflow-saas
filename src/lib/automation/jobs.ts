/**
 * Automation job queue — enqueue (idempotent), claim, retry-safe execute.
 *
 * Reliability design (mirrors the Meta leadgen + WhatsApp pipelines):
 * - The (businessId, dedupeKey) unique constraint is the idempotency key:
 *   concurrent enqueues of the same trigger+lead collapse to one row.
 * - Redis carries only a wake-up signal; the row is the source of truth,
 *   so execution proceeds (via inline drain / drain endpoint / worker)
 *   even when Redis is down.
 * - Claim: QUEUED → SENDING (stale SENDING claims are reclaimable);
 *   FAILED rows requeue only when attempts remain and the backoff elapsed.
 * - Each action runs inside its own try/catch with a pre-check of the
 *   job's SUCCESS logs, so a retry after partial progress never
 *   double-applies (no duplicate follow-ups, assigns, or sends).
 * - Every action outcome lands in AutomationLog: SUCCESS rows are the
 *   automation logs, FAILED rows are the failure logs, SKIPPED rows
 *   explain why nothing happened.
 */
import { AutomationJobTable, AutomationLogTable, LeadTable } from "../../prisma/tables";
import { recordLeadActivity } from "../tenancy/activities";
import { toBusinessId, toDbId } from "../tenancy/businesses";
import {
  actionsForTrigger,
  backoffForAttempt,
  dedupeKeyFor,
  isRetryableAutomationFailure,
  MAX_AUTOMATION_ATTEMPTS,
  shouldFireNoContact,
  STALE_CLAIM_MS,
  type AutomationAction,
  type AutomationTrigger,
} from "./engine";
import { executeAction } from "./actions";
import { enabledRulesForTrigger } from "./rules";
import { pushQueueSignal } from "./redis";

export type JobStatus = "QUEUED" | "SENDING" | "DONE" | "FAILED";

export interface AutomationJobDTO {
  id: string;
  businessId: string;
  ruleId: string | null;
  trigger: string;
  leadId: string;
  dedupeKey: string;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationLogDTO {
  id: string;
  businessId: string;
  ruleId: string | null;
  jobId: string | null;
  leadId: string | null;
  trigger: string;
  action: string;
  status: string;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

const JOB_FIELDS = [
  "id",
  "businessId",
  "ruleId",
  "trigger",
  "leadId",
  "dedupeKey",
  "payloadJson",
  "status",
  "attempts",
  "lastError",
  "nextRetryAt",
  "createdAt",
  "updatedAt",
] as const;

const LOG_FIELDS = [
  "id",
  "businessId",
  "ruleId",
  "jobId",
  "leadId",
  "trigger",
  "action",
  "status",
  "detail",
  "createdAt",
  "updatedAt",
] as const;

type JobRow = {
  id: string;
  businessId: string;
  ruleId: string | null;
  trigger: string;
  leadId: string;
  dedupeKey: string;
  payloadJson: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type LogRow = {
  id: string;
  businessId: string;
  ruleId: string | null;
  jobId: string | null;
  leadId: string | null;
  trigger: string;
  action: string;
  status: string;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
};

function toJobDTO(row: JobRow): AutomationJobDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    ruleId: row.ruleId,
    trigger: row.trigger,
    leadId: row.leadId,
    dedupeKey: row.dedupeKey,
    status: row.status as JobStatus,
    attempts: row.attempts,
    lastError: row.lastError,
    nextRetryAt: row.nextRetryAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toLogDTO(row: LogRow): AutomationLogDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    ruleId: row.ruleId,
    jobId: row.jobId,
    leadId: row.leadId,
    trigger: row.trigger,
    action: row.action,
    status: row.status,
    detail: row.detail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Unknown automation error.";
  return message.replace(/EAA[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);
}

async function jobsInBusiness(businessId: string): Promise<JobRow[]> {
  const bid = toBusinessId(businessId);
  return AutomationJobTable.where((j) => j.businessId.eq(bid))
    .select(...JOB_FIELDS)
    .all();
}

async function logsInBusiness(businessId: string): Promise<LogRow[]> {
  const bid = toBusinessId(businessId);
  return AutomationLogTable.where((l) => l.businessId.eq(bid))
    .select(...LOG_FIELDS)
    .all();
}

async function setJob(id: string, patch: Partial<Pick<JobRow, "status" | "attempts" | "lastError" | "nextRetryAt">>) {
  const update: Record<string, unknown> = {};
  if (patch.status !== undefined) update["status"] = patch.status;
  if (patch.attempts !== undefined) update["attempts"] = patch.attempts;
  if (patch.lastError !== undefined) update["lastError"] = patch.lastError;
  if (patch.nextRetryAt !== undefined) update["nextRetryAt"] = patch.nextRetryAt;
  await AutomationJobTable.where({ id: toDbId(id) }).update(update as never);
}

async function writeLog(
  businessId: string,
  opts: {
    ruleId?: string | null;
    jobId?: string | null;
    leadId?: string | null;
    trigger: string;
    action: string;
    status: "SUCCESS" | "FAILED" | "SKIPPED";
    detail?: string | null;
  }
): Promise<void> {
  const bid = toBusinessId(businessId);
  await AutomationLogTable.select("id").create({
    businessId: bid,
    ...(opts.ruleId ? { ruleId: toDbId(opts.ruleId) } : {}),
    ...(opts.jobId ? { jobId: toDbId(opts.jobId) } : {}),
    ...(opts.leadId ? { leadId: toDbId(opts.leadId) } : {}),
    trigger: opts.trigger,
    action: opts.action,
    status: opts.status,
    ...(opts.detail !== undefined && opts.detail !== null ? { detail: opts.detail.slice(0, 2000) } : {}),
  });
}

export interface EnqueueOutcome {
  job: AutomationJobDTO;
  duplicate: boolean;
}

/**
 * Enqueue one job idempotently. The (businessId, dedupeKey) unique
 * constraint collapses concurrent duplicates; the losers re-read the
 * winner. Never throws for duplicates.
 */
export async function enqueueAutomationJob(
  businessId: string,
  ruleId: string,
  trigger: AutomationTrigger,
  leadId: string,
  dedupeKey: string,
  payload?: Record<string, unknown>
): Promise<EnqueueOutcome> {
  const existing = (await jobsInBusiness(businessId)).find((j) => j.dedupeKey === dedupeKey) ?? null;
  if (existing) return { job: toJobDTO(existing), duplicate: true };
  try {
    const row = await AutomationJobTable.select(...JOB_FIELDS).create({
      businessId: toBusinessId(businessId),
      ruleId: toDbId(ruleId),
      trigger,
      leadId: toDbId(leadId),
      dedupeKey,
      ...(payload ? { payloadJson: JSON.stringify(payload).slice(0, 4000) } : {}),
    });
    const job = toJobDTO(row);
    // Wake-up signal only — the row is the source of truth.
    pushQueueSignal(job.id).catch(() => null);
    return { job, duplicate: false };
  } catch {
    const winner = (await jobsInBusiness(businessId)).find((j) => j.dedupeKey === dedupeKey) ?? null;
    if (winner) return { job: toJobDTO(winner), duplicate: true };
    throw new Error("Failed to enqueue automation job.");
  }
}

export interface EmitSummary {
  enqueued: number;
  duplicates: number;
}

/**
 * Fire a trigger for a lead: enqueue one job per enabled rule, then drain
 * due jobs inline (bounded) so request-path triggers execute promptly
 * without worker infra. Best-effort throughout — callers never fail
 * because automation failed.
 */
export async function emitAutomationTrigger(
  businessId: string,
  trigger: AutomationTrigger,
  leadId: string,
  opts?: { payload?: Record<string, unknown>; nowMs?: number; inlineDrain?: boolean }
): Promise<EmitSummary> {
  const summary: EmitSummary = { enqueued: 0, duplicates: 0 };
  const nowMs = opts?.nowMs ?? Date.now();
  let rules;
  try {
    rules = await enabledRulesForTrigger(businessId, trigger);
  } catch {
    console.error("[automation] failed to load rules", { businessId, trigger });
    return summary;
  }
  for (const rule of rules) {
    // Skip rules whose configured action list is empty after canonical filtering.
    if (actionsForTrigger(trigger, rule.config).length === 0) {
      await writeLog(businessId, {
        ruleId: rule.id,
        leadId,
        trigger,
        action: "TRIGGER",
        status: "SKIPPED",
        detail: "Rule has no actions configured.",
      }).catch(() => null);
      continue;
    }
    try {
      const outcome = await enqueueAutomationJob(
        businessId,
        rule.id,
        trigger,
        leadId,
        dedupeKeyFor(trigger, rule.id, leadId, nowMs),
        opts?.payload
      );
      if (outcome.duplicate) summary.duplicates += 1;
      else summary.enqueued += 1;
    } catch (err) {
      console.error("[automation] failed to enqueue job", {
        businessId,
        trigger,
        ruleId: rule.id,
        error: sanitizeError(err),
      });
    }
  }
  if (opts?.inlineDrain === false) return summary;
  try {
    await drainDueAutomationJobs(businessId, { limit: 20, nowMs });
  } catch (err) {
    console.error("[automation] inline drain failed", { businessId, error: sanitizeError(err) });
  }
  return summary;
}

function isDue(row: JobRow, nowMs: number): boolean {
  if (row.status === "QUEUED") {
    if (row.nextRetryAt && new Date(row.nextRetryAt).getTime() > nowMs) return false;
    return true;
  }
  if (row.status === "SENDING") {
    const claimedAt = new Date(row.updatedAt).getTime();
    return Number.isFinite(claimedAt) && nowMs - claimedAt >= STALE_CLAIM_MS;
  }
  if (row.status === "FAILED") {
    if (row.attempts >= MAX_AUTOMATION_ATTEMPTS) return false;
    if (row.nextRetryAt && new Date(row.nextRetryAt).getTime() > nowMs) return false;
    return true;
  }
  return false;
}

export interface DrainSummary {
  processed: number;
  done: number;
  deferred: number;
  failed: number;
}

/**
 * Execute due jobs in a business (bounded by limit). Claim QUEUED →
 * SENDING, run actions with per-action guards, then settle DONE / FAILED
 * (+backoff) / FAILED terminal. Safe to call concurrently: claims are
 * single-writer via the status transition and stale-claim recovery.
 */
export async function drainDueAutomationJobs(
  businessId: string,
  opts?: { limit?: number; nowMs?: number }
): Promise<DrainSummary> {
  const summary: DrainSummary = { processed: 0, done: 0, deferred: 0, failed: 0 };
  const nowMs = opts?.nowMs ?? Date.now();
  const limit = opts?.limit ?? 50;
  const due = (await jobsInBusiness(businessId)).filter((j) => isDue(j, nowMs)).slice(0, limit);
  for (const job of due) {
    summary.processed += 1;
    const outcome = await executeAutomationJob(businessId, job.id, nowMs).catch(() => "error" as const);
    if (outcome === "done") summary.done += 1;
    else if (outcome === "deferred") summary.deferred += 1;
    else summary.failed += 1;
  }
  return summary;
}

type ExecuteOutcome = "done" | "deferred" | "failed";

async function executeAutomationJob(businessId: string, jobId: string, nowMs: number): Promise<ExecuteOutcome> {
  const stored = (await jobsInBusiness(businessId)).find((j) => j.id === jobId) ?? null;
  if (!stored || !isDue(stored, nowMs)) return "failed";
  await setJob(stored.id, { status: "SENDING" });

  // Resolve the rule snapshot: deleted/disabled rules skip gracefully.
  let ruleName = "deleted rule";
  let actions: AutomationAction[] = [];
  const ruleId: string | null = stored.ruleId;
  if (stored.ruleId) {
    const rules = await enabledRulesForTrigger(businessId, stored.trigger as AutomationTrigger).catch(() => []);
    const match = rules.find((r) => r.id === stored.ruleId) ?? null;
    if (!match) {
      await writeLog(businessId, {
        ruleId: stored.ruleId,
        jobId: stored.id,
        leadId: stored.leadId,
        trigger: stored.trigger,
        action: "TRIGGER",
        status: "SKIPPED",
        detail: "Rule was deleted or disabled before execution.",
      }).catch(() => null);
      await setJob(stored.id, { status: "DONE", lastError: null, nextRetryAt: null });
      return "done";
    }
    ruleName = match.name;
    actions = actionsForTrigger(stored.trigger as AutomationTrigger, match.config);
    // Fresh config snapshot per execution (rules are editable).
    return runActions(businessId, stored, ruleId, ruleName, actions, match.config, nowMs);
  }
  return runActions(businessId, stored, ruleId, ruleName, actions, null, nowMs);
}

async function runActions(
  businessId: string,
  stored: JobRow,
  ruleId: string | null,
  ruleName: string,
  actions: AutomationAction[],
  config: Parameters<typeof executeAction>[3] | null,
  nowMs: number
): Promise<ExecuteOutcome> {
  if (actions.length === 0 || !config) {
    await setJob(stored.id, { status: "DONE", lastError: null, nextRetryAt: null });
    return "done";
  }
  const priorLogs = await logsInBusiness(businessId).catch(() => [] as LogRow[]);
  const succeeded = new Set(
    priorLogs.filter((l) => l.jobId === stored.id && l.status === "SUCCESS").map((l) => l.action)
  );
  let terminalError: string | null = null;
  let retryableError: string | null = null;

  for (const action of actions) {
    if (succeeded.has(action)) continue;
    try {
      const result = await executeAction(action, businessId, stored.leadId, config, ruleName);
      await writeLog(businessId, {
        ruleId,
        jobId: stored.id,
        leadId: stored.leadId,
        trigger: stored.trigger,
        action,
        status: result.status,
        detail: result.detail,
      });
    } catch (err) {
      const message = sanitizeError(err);
      const retryable = isRetryableAutomationFailure(err);
      await writeLog(businessId, {
        ruleId,
        jobId: stored.id,
        leadId: stored.leadId,
        trigger: stored.trigger,
        action,
        status: "FAILED",
        detail: message,
      }).catch(() => null);
      console.error("[automation] action failed", {
        businessId,
        jobId: stored.id,
        action,
        retryable,
        error: message,
      });
      if (retryable) {
        if (!retryableError) retryableError = `${action}: ${message}`;
      } else {
        terminalError = `${action}: ${message}`;
        break;
      }
    }
  }

  const attempts = stored.attempts + 1;
  if (terminalError) {
    await setJob(stored.id, { status: "FAILED", attempts, lastError: terminalError, nextRetryAt: null });
    return "failed";
  }
  if (retryableError) {
    if (attempts >= MAX_AUTOMATION_ATTEMPTS) {
      await setJob(stored.id, { status: "FAILED", attempts, lastError: retryableError, nextRetryAt: null });
      return "failed";
    }
    await setJob(stored.id, {
      status: "FAILED",
      attempts,
      lastError: retryableError,
      nextRetryAt: new Date(nowMs + backoffForAttempt(attempts)).toISOString(),
    });
    return "deferred";
  }
  await setJob(stored.id, { status: "DONE", lastError: null, nextRetryAt: null });
  try {
    await recordLeadActivity(businessId, stored.leadId, "NOTE_ADDED", `Automation "${ruleName}" completed.`);
  } catch {
    // Timeline note is cosmetic — the DONE state is already persisted.
  }
  return "done";
}

/** Retry a FAILED job with attempts left (safe manual retry entrypoint). */
export async function retryAutomationJob(businessId: string, jobId: string): Promise<AutomationJobDTO> {
  const row = (await jobsInBusiness(businessId)).find((j) => j.id === jobId) ?? null;
  if (!row) throw new Error("Job not found.");
  if (row.status !== "FAILED") throw new Error("Only failed jobs can be retried.");
  if (row.attempts >= MAX_AUTOMATION_ATTEMPTS) throw new Error("Retry budget exhausted for this job.");
  await setJob(row.id, { status: "QUEUED", lastError: null, nextRetryAt: null });
  await drainDueAutomationJobs(businessId, { limit: 10 });
  const refreshed = (await jobsInBusiness(businessId)).find((j) => j.id === jobId) ?? null;
  if (!refreshed) throw new Error("Job not found.");
  return toJobDTO(refreshed);
}

export interface SweepSummary {
  scanned: number;
  enqueued: number;
  duplicates: number;
  drained: DrainSummary;
}

/**
 * NO_CONTACT_AFTER_TIME sweeper: scan active leads, enqueue one job per
 * enabled NO_CONTACT rule for silent leads (daily idempotency bucket),
 * then drain. Invoked by the sweep endpoint and the worker script.
 */
export async function sweepNoContactLeads(businessId: string, nowMs = Date.now()): Promise<SweepSummary> {
  const summary: SweepSummary = {
    scanned: 0,
    enqueued: 0,
    duplicates: 0,
    drained: { processed: 0, done: 0, deferred: 0, failed: 0 },
  };
  const rules = await enabledRulesForTrigger(businessId, "NO_CONTACT_AFTER_TIME").catch(() => []);
  if (rules.length === 0) return summary;
  const bid = toBusinessId(businessId);
  const leads = await LeadTable.where((l) => l.businessId.eq(bid))
    .select("id", "status", "archivedAt", "createdAt", "lastContactedAt")
    .all();
  summary.scanned = leads.length;
  for (const rule of rules) {
    for (const lead of leads) {
      if (
        !shouldFireNoContact(
          {
            status: lead.status,
            archivedAt: lead.archivedAt,
            createdAt: lead.createdAt,
            lastContactedAt: lead.lastContactedAt,
          },
          rule.config.noContactMinutes,
          nowMs
        )
      ) {
        continue;
      }
      try {
        const outcome = await enqueueAutomationJob(
          businessId,
          rule.id,
          "NO_CONTACT_AFTER_TIME",
          lead.id,
          dedupeKeyFor("NO_CONTACT_AFTER_TIME", rule.id, lead.id, nowMs)
        );
        if (outcome.duplicate) summary.duplicates += 1;
        else summary.enqueued += 1;
      } catch {
        console.error("[automation] sweep enqueue failed", { businessId, leadId: lead.id });
      }
    }
  }
  summary.drained = await drainDueAutomationJobs(businessId, { limit: 50, nowMs }).catch(() => summary.drained);
  return summary;
}

/** Job + log listing helpers for the API (scoped, newest-first for logs). */
export async function listAutomationJobs(
  businessId: string,
  filter?: { status?: string; trigger?: string }
): Promise<AutomationJobDTO[]> {
  const rows = await jobsInBusiness(businessId);
  return rows
    .filter(
      (r) =>
        (!filter?.status || filter.status === "all" || r.status === filter.status) &&
        (!filter?.trigger || filter.trigger === "all" || r.trigger === filter.trigger)
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(toJobDTO);
}

export async function listAutomationLogs(
  businessId: string,
  filter?: { status?: string; action?: string; leadId?: string }
): Promise<AutomationLogDTO[]> {
  const rows = await logsInBusiness(businessId);
  return rows
    .filter(
      (r) =>
        (!filter?.status || filter.status === "all" || r.status === filter.status) &&
        (!filter?.action || filter.action === "all" || r.action === filter.action) &&
        (!filter?.leadId || r.leadId === filter.leadId)
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 200)
    .map(toLogDTO);
}
