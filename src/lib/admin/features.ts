/**
 * Centralized feature-access system (server-only).
 *
 * Replaces scattered `if (plan === "pro")` checks. Every product gate in
 * the app should call `hasFeatureAccess({ planCode, feature })`.
 *
 * Layers:
 *   1. Global kill-switch via env `FEATURE_<KEY>_ENABLED=false`.
 *   2. Plan defaults in FEATURE_PLAN_MAP below.
 *   3. Workspace/user overrides — BACKEND REQUIREMENT: persisted in a
 *      future `FeatureOverride(businessId?, userId?, feature, enabled)`
 *      table. `workspaceOverrides` / `userOverrides` params already exist
 *      so call sites don't change when the table lands.
 */
import type { PlanCode } from "../billing/catalog";

export const FEATURE_KEYS = [
  "facebook_lead_ads",
  "whatsapp_integration",
  "advanced_analytics",
  "campaign_analytics",
  "automation",
  "ai_features",
  "api_access",
  "export",
  "team_management",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface FeatureDef {
  key: FeatureKey;
  name: string;
  description: string;
}

export const FEATURE_CATALOG: FeatureDef[] = [
  { key: "facebook_lead_ads", name: "Facebook Lead Ads", description: "Meta Lead Ads OAuth, pages, forms, webhook sync." },
  { key: "whatsapp_integration", name: "WhatsApp integration", description: "WABA connections, templates, messaging." },
  { key: "advanced_analytics", name: "Advanced analytics", description: "Workspace analytics dashboards." },
  { key: "campaign_analytics", name: "Campaign analytics", description: "Per-campaign / ad-set attribution." },
  { key: "automation", name: "Automation", description: "Automation rules engine and background jobs." },
  { key: "ai_features", name: "AI features", description: "AI-assisted messaging, scoring, summaries." },
  { key: "api_access", name: "API access", description: "Public API tokens for a workspace." },
  { key: "export", name: "Export", description: "CSV export of leads and reports." },
  { key: "team_management", name: "Team management", description: "Multi-member workspaces and roles." },
];

/** Plan defaults: minimum plan that unlocks each feature. FREE has none beyond core CRM. */
const FEATURE_MIN_PLAN: Record<FeatureKey, PlanCode | null> = {
  facebook_lead_ads: "STARTER",
  whatsapp_integration: "STARTER",
  advanced_analytics: "GROWTH",
  campaign_analytics: "GROWTH",
  automation: "STARTER",
  ai_features: "BUSINESS",
  api_access: "BUSINESS",
  export: "STARTER",
  team_management: "STARTER",
};

const PLAN_RANK: Record<PlanCode, number> = {
  FREE: 0,
  STARTER: 1,
  GROWTH: 2,
  BUSINESS: 3,
  AGENCY: 4,
};

export interface FeatureAccessInput {
  planCode: string;
  feature: FeatureKey;
  /** Future DB overrides; explicit workspace grant/deny wins over plan default. */
  workspaceOverrides?: Record<string, boolean>;
  userOverrides?: Record<string, boolean>;
}

export function isFeatureGloballyEnabled(feature: FeatureKey): boolean {
  const raw = process.env[`FEATURE_${feature.toUpperCase()}_ENABLED`];
  if (raw === undefined) return true;
  return raw !== "false" && raw !== "0" && raw !== "no";
}

/** Single entry point for every feature gate in the app. */
export function hasFeatureAccess(input: FeatureAccessInput): boolean {
  if (!isFeatureGloballyEnabled(input.feature)) return false;
  const user = input.userOverrides?.[input.feature];
  if (user !== undefined) return user;
  const ws = input.workspaceOverrides?.[input.feature];
  if (ws !== undefined) return ws;
  const min = FEATURE_MIN_PLAN[input.feature];
  if (min === null) return true;
  const rank = PLAN_RANK[input.planCode as PlanCode] ?? 0;
  return rank >= PLAN_RANK[min];
}

/** Admin matrix row: which plans include each feature (for the Features page). */
export function listFeaturesAdmin(): Array<FeatureDef & { plans: PlanCode[]; globallyEnabled: boolean }> {
  const plans: PlanCode[] = ["FREE", "STARTER", "GROWTH", "BUSINESS", "AGENCY"];
  return FEATURE_CATALOG.map((f) => ({
    ...f,
    plans: plans.filter((p) => hasFeatureAccess({ planCode: p, feature: f.key })),
    globallyEnabled: isFeatureGloballyEnabled(f.key),
  }));
}
