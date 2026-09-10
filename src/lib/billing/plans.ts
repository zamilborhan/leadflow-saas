/**
 * Plan catalog persistence. The `Plan` table mirrors the static catalog in
 * `catalog.ts` for introspection and admin UIs; enforcement reads the
 * static catalog (see roles.ts for the same pattern), so seed state can
 * never widen access.
 */
import { PlanTable } from "../../prisma/tables";
import { PLANS, type PlanCode, type PlanLimits } from "./catalog";

export async function ensurePlanSeeds(): Promise<void> {
  for (const code of Object.keys(PLANS) as PlanCode[]) {
    const want = PLANS[code];
    const existing = await PlanTable.where({ code }).select("id").first();
    if (existing) continue;
    await PlanTable.select("id").create({
      code: want.code,
      name: want.name,
      leadsPerMonth: want.leadsPerMonth,
      maxUsers: want.maxUsers,
      ...(want.maxBusinesses === null ? {} : { maxBusinesses: want.maxBusinesses }),
    });
  }
}

/** Seeded plan rows (admin/introspection reads). */
export async function listPlans(): Promise<PlanLimits[]> {
  const rows = await PlanTable.select("code", "name", "leadsPerMonth", "maxUsers", "maxBusinesses").all();
  const byCode = new Map(rows.map((r) => [r.code as string, r]));
  return (Object.keys(PLANS) as PlanCode[]).map((code) => {
    const row = byCode.get(code);
    const fallback = PLANS[code];
    return {
      code,
      name: typeof row?.name === "string" ? (row.name as string) : fallback.name,
      leadsPerMonth: typeof row?.leadsPerMonth === "number" ? (row.leadsPerMonth as number) : fallback.leadsPerMonth,
      maxUsers: typeof row?.maxUsers === "number" ? (row.maxUsers as number) : fallback.maxUsers,
      maxBusinesses: (row?.maxBusinesses as number | null | undefined) ?? fallback.maxBusinesses,
      priceMinor: fallback.priceMinor,
      currency: fallback.currency,
    };
  });
}
