/**
 * Automation engine core — pure module (no imports) so unit tests exercise
 * it directly via Node type-stripping.
 *
 * Model: a workspace owns AutomationRules (trigger → ordered actions +
 * JSON config). A trigger firing enqueues one AutomationJob per enabled
 * rule; the job row is the source of truth (Redis carries only a wake-up
 * signal). The executor runs actions in order with per-action
 * try/catch, records every outcome in AutomationLog (SUCCESS | FAILED |
 * SKIPPED), and retries retryable failures with backoff. The
 * (businessId, dedupeKey) unique constraint is the idempotency key, and
 * each action re-checks its own SUCCESS log before running, so retries
 * never double-apply.
 *
 * Triggers: NEW_LEAD | NO_CONTACT_AFTER_TIME | STATUS_CHANGED_TO_INTERESTED
 * Actions: ASSIGN_AGENT | CREATE_FOLLOWUP | SEND_WHATSAPP | NOTIFY_AGENT |
 *   CREATE_REMINDER
 */

export const AUTOMATION_TRIGGERS = [
  "NEW_LEAD",
  "NO_CONTACT_AFTER_TIME",
  "STATUS_CHANGED_TO_INTERESTED",
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_ACTIONS = [
  "ASSIGN_AGENT",
  "CREATE_FOLLOWUP",
  "SEND_WHATSAPP",
  "NOTIFY_AGENT",
  "CREATE_REMINDER",
] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

export const AUTOMATION_JOB_STATUSES = ["QUEUED", "SENDING", "DONE", "FAILED"] as const;
export const AUTOMATION_LOG_STATUSES = ["SUCCESS", "FAILED", "SKIPPED"] as const;

export const RULE_STATUS_ENABLED = "ENABLED" as const;
export const RULE_STATUS_DISABLED = "DISABLED" as const;

export function isValidTrigger(v: unknown): v is AutomationTrigger {
  return typeof v === "string" && (AUTOMATION_TRIGGERS as readonly string[]).includes(v);
}

export function isValidAction(v: unknown): v is AutomationAction {
  return typeof v === "string" && (AUTOMATION_ACTIONS as readonly string[]).includes(v);
}

export function isValidRuleStatus(v: unknown): boolean {
  return v === RULE_STATUS_ENABLED || v === RULE_STATUS_DISABLED;
}

/** Canonical action order per trigger (config may narrow, never reorder). */
export const TRIGGER_ACTIONS: Record<AutomationTrigger, AutomationAction[]> = {
  NEW_LEAD: ["ASSIGN_AGENT", "CREATE_FOLLOWUP", "SEND_WHATSAPP", "NOTIFY_AGENT"],
  NO_CONTACT_AFTER_TIME: ["CREATE_REMINDER", "NOTIFY_AGENT"],
  STATUS_CHANGED_TO_INTERESTED: ["CREATE_FOLLOWUP"],
};

export interface RuleConfig {
  /** Follow-up delay after the trigger fires. */
  followUpDelayMinutes: number;
  /** Reminder delay for NO_CONTACT_AFTER_TIME. */
  reminderDelayMinutes: number;
  /** Silence window that defines "no contact". */
  noContactMinutes: number;
  /** Preferred template for SEND_WHATSAPP (falls back to lead selection). */
  templateName: string | null;
  templateLanguage: string | null;
  /** Template variables for SEND_WHATSAPP. */
  variables: Record<string, string>;
  /** Follow-up / reminder note text. */
  note: string | null;
  /** Agent assignment strategy. */
  assignStrategy: "least-loaded";
  /** Optional subset of TRIGGER_ACTIONS to run (must be a subset). */
  actions: AutomationAction[] | null;
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  followUpDelayMinutes: 1440,
  reminderDelayMinutes: 60,
  noContactMinutes: 1440,
  templateName: null,
  templateLanguage: null,
  variables: {},
  note: null,
  assignStrategy: "least-loaded",
  actions: null,
};

export interface DefaultRule {
  trigger: AutomationTrigger;
  name: string;
  config: RuleConfig;
}

/** Seed defaults: one rule per trigger, all enabled, fully editable. */
export const DEFAULT_RULES: DefaultRule[] = [
  {
    trigger: "NEW_LEAD",
    name: "New lead instant follow-up",
    config: { ...DEFAULT_RULE_CONFIG, note: "Automated follow-up for a new lead." },
  },
  {
    trigger: "NO_CONTACT_AFTER_TIME",
    name: "No-contact nudge",
    config: { ...DEFAULT_RULE_CONFIG, note: "No contact yet — reach out to this lead." },
  },
  {
    trigger: "STATUS_CHANGED_TO_INTERESTED",
    name: "Interested fast-track",
    config: { ...DEFAULT_RULE_CONFIG, note: "Lead turned interested — follow up fast." },
  },
];

export interface RuleConfigValidation {
  ok: boolean;
  value?: RuleConfig;
  errors: Record<string, string>;
}

function fail(errors: Record<string, string>): RuleConfigValidation {
  return { ok: false, errors };
}

function asPositiveInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10080) return v;
  return null;
}

/**
 * Validate a partial rule config patch against the trigger's needs.
 * Unknown keys are rejected; missing keys keep their current values.
 */
export function validateRuleConfig(
  input: unknown,
  current: RuleConfig = DEFAULT_RULE_CONFIG
): RuleConfigValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail({ config: "Config must be an object." });
  }
  const obj = input as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const next: RuleConfig = {
    ...current,
    variables: { ...current.variables },
    actions: current.actions ? [...current.actions] : null,
  };

  const ALLOWED = new Set([
    "followUpDelayMinutes",
    "reminderDelayMinutes",
    "noContactMinutes",
    "templateName",
    "templateLanguage",
    "variables",
    "note",
    "assignStrategy",
    "actions",
  ]);
  for (const key of Object.keys(obj)) {
    if (!ALLOWED.has(key)) errors[key] = `Unknown config key: ${key}.`;
  }
  if (Object.keys(errors).length > 0) return fail(errors);

  if (obj["followUpDelayMinutes"] !== undefined) {
    const n = asPositiveInt(obj["followUpDelayMinutes"]);
    if (n === null) errors["followUpDelayMinutes"] = "Must be an integer 0–10080 (minutes).";
    else next.followUpDelayMinutes = n;
  }
  if (obj["reminderDelayMinutes"] !== undefined) {
    const n = asPositiveInt(obj["reminderDelayMinutes"]);
    if (n === null) errors["reminderDelayMinutes"] = "Must be an integer 0–10080 (minutes).";
    else next.reminderDelayMinutes = n;
  }
  if (obj["noContactMinutes"] !== undefined) {
    const n = asPositiveInt(obj["noContactMinutes"]);
    if (n === null || n <= 0) errors["noContactMinutes"] = "Must be a positive integer (minutes).";
    else next.noContactMinutes = n;
  }
  if (obj["templateName"] !== undefined) {
    const v = obj["templateName"];
    if (v === null || v === "") next.templateName = null;
    else if (typeof v !== "string" || v.trim().length === 0 || v.trim().length > 200) {
      errors["templateName"] = "Must be a template name (≤200 chars) or null.";
    } else next.templateName = v.trim();
  }
  if (obj["templateLanguage"] !== undefined) {
    const v = obj["templateLanguage"];
    if (v === null || v === "") next.templateLanguage = null;
    else if (typeof v !== "string" || v.trim().length === 0 || v.trim().length > 20) {
      errors["templateLanguage"] = "Must be a language code (≤20 chars) or null.";
    } else next.templateLanguage = v.trim();
  }
  if (obj["variables"] !== undefined) {
    const v = obj["variables"];
    if (v === null) next.variables = {};
    else if (typeof v !== "object" || Array.isArray(v)) {
      errors["variables"] = "Must be an object of key/value strings.";
    } else {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val !== "string") {
          errors["variables"] = "Must be an object of key/value strings.";
          break;
        }
        if (k.length > 0) out[k.slice(0, 100)] = val.slice(0, 1024);
      }
      if (!errors["variables"]) next.variables = out;
    }
  }
  if (obj["note"] !== undefined) {
    const v = obj["note"];
    if (v === null || v === "") next.note = null;
    else if (typeof v !== "string" || v.trim().length === 0 || v.trim().length > 2000) {
      errors["note"] = "Must be text (≤2000 chars) or null.";
    } else next.note = v.trim();
  }
  if (obj["assignStrategy"] !== undefined) {
    if (obj["assignStrategy"] !== "least-loaded") {
      errors["assignStrategy"] = 'Must be "least-loaded".';
    } else next.assignStrategy = "least-loaded";
  }
  if (obj["actions"] !== undefined) {
    const v = obj["actions"];
    if (v === null) next.actions = null;
    else if (!Array.isArray(v) || v.length === 0 || !v.every(isValidAction)) {
      errors["actions"] = `Must be a non-empty subset of: ${AUTOMATION_ACTIONS.join(", ")}.`;
    } else {
      const seen = new Set<string>();
      const deduped = (v as AutomationAction[]).filter((a) => {
        if (seen.has(a)) return false;
        seen.add(a);
        return true;
      });
      next.actions = deduped;
    }
  }

  if (Object.keys(errors).length > 0) return fail(errors);
  return { ok: true, value: next, errors: {} };
}

/** Parse stored configJson defensively — corrupt rows fall back to defaults. */
export function parseRuleConfig(json: string | null): RuleConfig {
  if (!json) return { ...DEFAULT_RULE_CONFIG, variables: {} };
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_RULE_CONFIG, variables: {} };
    }
    const checked = validateRuleConfig(parsed, DEFAULT_RULE_CONFIG);
    if (checked.ok && checked.value) return checked.value;
    return { ...DEFAULT_RULE_CONFIG, variables: {} };
  } catch {
    return { ...DEFAULT_RULE_CONFIG, variables: {} };
  }
}

/** Effective action list: configured subset (in canonical order) or the trigger default. */
export function actionsForTrigger(trigger: AutomationTrigger, config: RuleConfig): AutomationAction[] {
  const canonical = TRIGGER_ACTIONS[trigger];
  if (!config.actions) return [...canonical];
  return canonical.filter((a) => config.actions!.includes(a));
}

/**
 * Idempotency key for a trigger firing. NO_CONTACT_AFTER_TIME buckets by
 * UTC date so the sweeper fires at most once per lead per day; all other
 * triggers fire at most once per (rule, lead).
 */
export function dedupeKeyFor(trigger: AutomationTrigger, ruleId: string, leadId: string, nowMs = Date.now()): string {
  if (trigger === "NO_CONTACT_AFTER_TIME") {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    return `${trigger}:${ruleId}:${leadId}:${day}`;
  }
  return `${trigger}:${ruleId}:${leadId}`;
}

const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];
export const MAX_AUTOMATION_ATTEMPTS = 5;
export const STALE_CLAIM_MS = 10 * 60_000;

export function backoffForAttempt(attempt: number): number {
  return RETRY_BACKOFF_MS[Math.min(Math.max(attempt - 1, 0), RETRY_BACKOFF_MS.length - 1)];
}

/**
 * Failure classification without domain imports (pure): terminal failures
 * must never be retried (validation, auth, missing data), everything else
 * is retryable within the attempt budget.
 */
export function isRetryableAutomationFailure(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  if (name === "TenantConflict" || name === "TenantNotFound" || name === "TenantAccessDenied") return false;
  if (name === "TemplateSendError") return false;
  if (err instanceof Error && /unreachable/i.test(err.message)) return true;
  if (name === "MetaApiError") {
    const code = (err as { code?: unknown }).code;
    return code === 1 || code === 2;
  }
  return true;
}

export interface AgentLoad {
  userId: string;
  openLeads: number;
}

/** Least-loaded agent wins; ties break by userId for determinism. */
export function pickLeastLoadedAgent(loads: AgentLoad[]): string | null {
  if (loads.length === 0) return null;
  const sorted = [...loads].sort((a, b) => a.openLeads - b.openLeads || (a.userId < b.userId ? -1 : 1));
  return sorted[0].userId;
}

export interface NoContactLead {
  status: string;
  archivedAt: string | null;
  createdAt: string;
  lastContactedAt: string | null;
}

const NO_CONTACT_STATUSES = new Set(["NEW", "CONTACTED", "FOLLOW_UP"]);

/** True when a lead has been silent for at least noContactMinutes. */
export function shouldFireNoContact(lead: NoContactLead, noContactMinutes: number, nowMs = Date.now()): boolean {
  if (lead.archivedAt) return false;
  if (!NO_CONTACT_STATUSES.has(lead.status)) return false;
  const cutoff = nowMs - noContactMinutes * 60_000;
  const lastTouch = lead.lastContactedAt ? new Date(lead.lastContactedAt).getTime() : null;
  // A lead with no recorded contact is judged by its creation time.
  const basis = lastTouch ?? new Date(lead.createdAt).getTime();
  if (!Number.isFinite(basis)) return false;
  return basis <= cutoff;
}
