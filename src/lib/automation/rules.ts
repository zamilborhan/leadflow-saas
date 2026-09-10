/**
 * Automation rule management — tenant-scoped CRUD + default seeding.
 *
 * Rules are workspace config: OWNER/ADMIN manage them (`automations.manage`
 * permission). Listing auto-seeds the three workspace defaults on first
 * use so every business starts automated but stays fully configurable
 * (rename, retune config, disable, delete, re-add).
 */
import { AutomationRuleTable } from "../../prisma/tables";
import type { BusinessContext } from "../tenancy/context";
import { requirePermission, TenantNotFound } from "../tenancy/policies";
import { toBusinessId, toDbId } from "../tenancy/businesses";
import {
  DEFAULT_RULES,
  isValidRuleStatus,
  isValidTrigger,
  parseRuleConfig,
  RULE_STATUS_DISABLED,
  RULE_STATUS_ENABLED,
  validateRuleConfig,
  type AutomationTrigger,
  type RuleConfig,
} from "./engine";

export const AUTOMATIONS_MANAGE_PERMISSION = "automations.manage" as const;

export interface AutomationRuleDTO {
  id: string;
  businessId: string;
  trigger: AutomationTrigger;
  name: string;
  status: string;
  enabled: boolean;
  config: RuleConfig;
  createdAt: string;
  updatedAt: string;
}

const RULE_FIELDS = ["id", "businessId", "trigger", "name", "status", "configJson", "createdAt", "updatedAt"] as const;

type RuleRow = {
  id: string;
  businessId: string;
  trigger: string;
  name: string;
  status: string;
  configJson: string;
  createdAt: string;
  updatedAt: string;
};

function toDTO(row: RuleRow): AutomationRuleDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    trigger: (isValidTrigger(row.trigger) ? row.trigger : "NEW_LEAD") as AutomationTrigger,
    name: row.name,
    status: row.status,
    enabled: row.status === RULE_STATUS_ENABLED,
    config: parseRuleConfig(row.configJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function rulesInBusiness(businessId: string): Promise<RuleRow[]> {
  const bid = toBusinessId(businessId);
  return AutomationRuleTable.where((r) => r.businessId.eq(bid))
    .select(...RULE_FIELDS)
    .all();
}

/**
 * Seed the three workspace defaults idempotently. The
 * (businessId, trigger, name) unique constraint is the backstop — races
 * collapse instead of duplicating.
 */
export async function ensureDefaultAutomationRules(businessId: string): Promise<AutomationRuleDTO[]> {
  const bid = toBusinessId(businessId);
  for (const def of DEFAULT_RULES) {
    try {
      await AutomationRuleTable.select("id").create({
        businessId: bid,
        trigger: def.trigger,
        name: def.name,
        status: RULE_STATUS_ENABLED,
        configJson: JSON.stringify(def.config),
      });
    } catch {
      // Already seeded (or raced) — fall through to the read below.
    }
  }
  return (await rulesInBusiness(businessId)).map(toDTO);
}

/** List rules; auto-seeds defaults when the workspace has none. */
export async function listAutomationRules(context: BusinessContext): Promise<AutomationRuleDTO[]> {
  requirePermission(context, AUTOMATIONS_MANAGE_PERMISSION);
  const rows = await rulesInBusiness(context.business.id);
  if (rows.length === 0) return ensureDefaultAutomationRules(context.business.id);
  return rows.map(toDTO);
}

export interface CreateRuleInput {
  trigger: string;
  name: string;
  config?: unknown;
}

export async function createAutomationRule(
  context: BusinessContext,
  input: CreateRuleInput
): Promise<AutomationRuleDTO> {
  requirePermission(context, AUTOMATIONS_MANAGE_PERMISSION);
  if (!isValidTrigger(input.trigger)) {
    throw new Error(`Invalid trigger: ${input.trigger}`);
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0 || name.length > 120) {
    throw new Error("Rule name is required (≤120 chars).");
  }
  const checked = validateRuleConfig(input.config ?? {});
  if (!checked.ok || !checked.value) {
    throw new Error(`Invalid config: ${Object.values(checked.errors).join(" ")}`);
  }
  const row = await AutomationRuleTable.select(...RULE_FIELDS).create({
    businessId: toBusinessId(context.business.id),
    trigger: input.trigger,
    name,
    status: RULE_STATUS_ENABLED,
    configJson: JSON.stringify(checked.value),
  });
  return toDTO(row);
}

async function findRuleInBusiness(ruleId: string, businessId: string): Promise<RuleRow | null> {
  const rows = await rulesInBusiness(businessId);
  return rows.find((r) => r.id === ruleId) ?? null;
}

export interface UpdateRuleInput {
  name?: string;
  /** ENABLED | DISABLED — the enable/disable switch. */
  status?: string;
  config?: unknown;
}

export async function updateAutomationRule(
  context: BusinessContext,
  ruleId: string,
  input: UpdateRuleInput
): Promise<AutomationRuleDTO | null> {
  requirePermission(context, AUTOMATIONS_MANAGE_PERMISSION);
  const existing = await findRuleInBusiness(ruleId, context.business.id);
  if (!existing) return null;
  const update: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length === 0 || name.length > 120) throw new Error("Rule name is required (≤120 chars).");
    update["name"] = name;
  }
  if (input.status !== undefined) {
    if (!isValidRuleStatus(input.status)) throw new Error("Status must be ENABLED or DISABLED.");
    update["status"] = input.status;
  }
  if (input.config !== undefined) {
    const checked = validateRuleConfig(input.config, parseRuleConfig(existing.configJson));
    if (!checked.ok || !checked.value) {
      throw new Error(`Invalid config: ${Object.values(checked.errors).join(" ")}`);
    }
    update["configJson"] = JSON.stringify(checked.value);
  }
  if (Object.keys(update).length === 0) return toDTO(existing);
  await AutomationRuleTable.where({ id: toDbId(existing.id) }).update(update as never);
  const refreshed = await findRuleInBusiness(ruleId, context.business.id);
  if (!refreshed) throw new TenantNotFound();
  return toDTO(refreshed);
}

export async function setRuleEnabled(
  context: BusinessContext,
  ruleId: string,
  enabled: boolean
): Promise<AutomationRuleDTO | null> {
  return updateAutomationRule(context, ruleId, {
    status: enabled ? RULE_STATUS_ENABLED : RULE_STATUS_DISABLED,
  });
}

export async function deleteAutomationRule(context: BusinessContext, ruleId: string): Promise<boolean> {
  requirePermission(context, AUTOMATIONS_MANAGE_PERMISSION);
  const existing = await findRuleInBusiness(ruleId, context.business.id);
  if (!existing) return false;
  await AutomationRuleTable.where({ id: toDbId(existing.id) }).delete();
  return true;
}

/** Enabled rules for a trigger (system path — no user permission needed). */
export async function enabledRulesForTrigger(
  businessId: string,
  trigger: AutomationTrigger
): Promise<AutomationRuleDTO[]> {
  const rows = await rulesInBusiness(businessId);
  return rows
    .filter((r) => r.trigger === trigger && r.status === RULE_STATUS_ENABLED && isValidTrigger(r.trigger))
    .map(toDTO);
}
