/**
 * Platform system health (super-admin only).
 *
 * Liveness probes only: table counts that prove each store answers, plus
 * process facts. Never emits secrets or tokens — environment is reported
 * as configured/unset booleans.
 */
import {
  AutomationJobTable,
  BusinessTable,
  LeadTable,
  SubscriptionTable,
  UserTable,
} from "../../prisma/tables";

export interface SystemHealth {
  ok: boolean;
  checkedAt: string;
  database: { ok: boolean; latencyMs: number | null };
  tables: Record<string, number | null>;
  runtime: { node: string; uptimeSeconds: number };
  integrations: {
    metaConfigured: boolean;
    whatsappConfigured: boolean;
    sslcommerzConfigured: boolean;
    redisConfigured: boolean;
  };
}

async function countOf(label: string, run: () => Promise<number>): Promise<[string, number | null]> {
  try {
    return [label, await run()];
  } catch {
    return [label, null];
  }
}

/** Platform health snapshot. Any store failure flips `ok` to false. */
export async function getSystemHealth(): Promise<SystemHealth> {
  const checkedAt = new Date().toISOString();
  const dbStart = Date.now();
  let dbOk = false;
  try {
    await BusinessTable.select("id").all();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const latencyMs = dbOk ? Date.now() - dbStart : null;

  const counts = await Promise.all([
    countOf("businesses", async () => (await BusinessTable.select("id").all()).length),
    countOf("users", async () => (await UserTable.select("id").all()).length),
    countOf("leads", async () => (await LeadTable.select("id").all()).length),
    countOf("subscriptions", async () => (await SubscriptionTable.select("id").all()).length),
    countOf("failedJobs", async () => (await AutomationJobTable.where((j) => j.status.eq("FAILED")).select("id").all()).length),
  ]);
  const tables: Record<string, number | null> = {};
  for (const [label, count] of counts) tables[label] = count;

  const has = (name: string): boolean => {
    const value = process.env[name];
    return value !== undefined && value.length > 0;
  };

  const ok = dbOk && Object.values(tables).every((c) => c !== null);
  return {
    ok,
    checkedAt,
    database: { ok: dbOk, latencyMs },
    tables,
    runtime: { node: process.version, uptimeSeconds: Math.floor(process.uptime()) },
    integrations: {
      metaConfigured: has("META_APP_ID") && has("META_APP_SECRET"),
      whatsappConfigured: has("WHATSAPP_ACCESS_TOKEN"),
      sslcommerzConfigured: has("SSLCOMMERZ_STORE_ID") && has("SSLCOMMERZ_STORE_SECRET"),
      redisConfigured: has("REDIS_URL"),
    },
  };
}
