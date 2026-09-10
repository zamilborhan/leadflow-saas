// LeadFlow automation worker — Redis-wake + interval drain loop.
//
// Runs outside Next.js (no session): it reacts to queue wake-up signals in
// Redis and also sweeps on a fixed interval so NO_CONTACT_AFTER_TIME rules
// fire even with no traffic, and so work still drains when Redis is down
// (the job rows are the source of truth; Redis is only a hint).
//
//   REDIS_URL / DATABASE_URL from the environment (dotenv supported).
//   node scripts/automation-worker.mjs
//
// Loop: BRPOP signal (≤30s) → drain due jobs in every business → every
// SWEEP_EVERY_MS also sweep NO_CONTACT_AFTER_TIME in every business.
import "dotenv/config";
import { BusinessTable } from "../src/prisma/tables.ts";
import { blockingPopQueueSignal } from "../src/lib/automation/redis.ts";
import { drainDueAutomationJobs, sweepNoContactLeads } from "../src/lib/automation/jobs.ts";

const SWEEP_EVERY_MS = Number(process.env["AUTOMATION_SWEEP_EVERY_MS"] ?? 5 * 60_000);
const DRAIN_LIMIT = Number(process.env["AUTOMATION_DRAIN_LIMIT"] ?? 50);

async function listBusinessIds() {
  try {
    // Suspended workspaces pause integrations: the worker skips them.
    const rows = await BusinessTable.select("id", "status").all();
    return rows.filter((r) => r.status !== "SUSPENDED").map((r) => r.id);
  } catch (err) {
    console.error("[automation-worker] failed to list businesses", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return [];
  }
}

async function drainAll() {
  for (const businessId of await listBusinessIds()) {
    try {
      const summary = await drainDueAutomationJobs(businessId, { limit: DRAIN_LIMIT });
      if (summary.processed > 0) {
        console.log("[automation-worker] drained", { businessId, ...summary });
      }
    } catch (err) {
      console.error("[automation-worker] drain failed", {
        businessId,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
}

async function sweepAll() {
  for (const businessId of await listBusinessIds()) {
    try {
      const summary = await sweepNoContactLeads(businessId);
      if (summary.enqueued > 0 || summary.duplicates > 0) {
        console.log("[automation-worker] swept", {
          businessId,
          scanned: summary.scanned,
          enqueued: summary.enqueued,
          duplicates: summary.duplicates,
        });
      }
    } catch (err) {
      console.error("[automation-worker] sweep failed", {
        businessId,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
}

async function main() {
  console.log("[automation-worker] starting", {
    sweepEveryMs: SWEEP_EVERY_MS,
    drainLimit: DRAIN_LIMIT,
  });
  let lastSweep = 0;
  for (;;) {
    // Wait for a wake-up signal (or time out so sweeps still run).
    await blockingPopQueueSignal(30).catch(() => null);
    await drainAll();
    // Signals may arrive in bursts — keep draining until quiet.
    await drainAll();
    if (Date.now() - lastSweep >= SWEEP_EVERY_MS) {
      lastSweep = Date.now();
      await sweepAll();
    }
  }
}

const stop = () => {
  console.log("[automation-worker] stopping");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

main().catch((err) => {
  console.error("[automation-worker] fatal", { error: err instanceof Error ? err.message : "unknown" });
  process.exit(1);
});
