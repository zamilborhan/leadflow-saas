/**
 * Integration control-plane reads (super-admin only).
 * Surfaces connection counts, sync health, and errors from REAL tables.
 * NEVER selects token ciphertext or secrets.
 */
import {
  AutomationJobTable,
  MetaConnectionTable,
  MetaFormTable,
  MetaLeadEventTable,
  MetaPageTable,
  WhatsAppConnectionTable,
  WhatsAppMessageTable,
} from "../../prisma/tables";
import { allOrEmpty } from "./query";

export interface IntegrationOverview {
  name: string;
  connected: number;
  errors: number;
  lastSync: string | null;
  status: "Operational" | "Degraded" | "Down" | "Unknown";
  note: string;
}

function latestIso(values: Array<string | null | undefined>): string | null {
  let best: number | null = null;
  let out: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (!Number.isFinite(t)) continue;
    if (best === null || t > best) {
      best = t;
      out = v;
    }
  }
  return out;
}

/** High-level integration health across the platform. */
export async function getIntegrationsOverview(): Promise<IntegrationOverview[]> {
  const [metaConns, waConns, metaEvents, waMessages, jobs] = await Promise.all([
    allOrEmpty(MetaConnectionTable.select("id", "status", "updatedAt").all()),
    allOrEmpty(WhatsAppConnectionTable.select("id", "status", "updatedAt").all()),
    allOrEmpty(MetaLeadEventTable.select("id", "status", "updatedAt").all()),
    allOrEmpty(WhatsAppMessageTable.select("id", "status", "updatedAt").all()),
    allOrEmpty(AutomationJobTable.select("id", "status").all()),
  ]);

  const metaErrors = metaEvents.filter((e) => e.status === "FAILED").length;
  const waErrors = waMessages.filter((m) => m.status === "FAILED").length;
  const failedJobs = jobs.filter((j) => j.status === "FAILED").length;

  const metaConfigured = (process.env["META_APP_ID"] ?? "") !== "";
  const waConfigured = (process.env["WHATSAPP_ACCESS_TOKEN"] ?? "") !== "";
  const sslConfigured = (process.env["SSLCOMMERZ_STORE_ID"] ?? "") !== "";
  const mailConfigured = (process.env["MAIL_PROVIDER"] ?? "log") !== "log";

  return [
    {
      name: "Facebook Lead Ads",
      connected: metaConns.length,
      errors: metaErrors,
      lastSync: latestIso(metaEvents.map((e) => e.updatedAt)),
      status: !metaConfigured ? "Unknown" : metaErrors > 10 ? "Degraded" : "Operational",
      note: metaConfigured ? "Meta app configured." : "META_APP_ID not configured.",
    },
    {
      name: "WhatsApp",
      connected: waConns.length,
      errors: waErrors,
      lastSync: latestIso(waMessages.map((m) => m.updatedAt)),
      status: !waConfigured && waConns.length === 0 ? "Unknown" : waErrors > 10 ? "Degraded" : "Operational",
      note: waConns.length === 0 ? "No workspaces connected yet." : "Connections present.",
    },
    {
      name: "Payments (SSLCommerz)",
      connected: 0,
      errors: 0,
      lastSync: null,
      status: sslConfigured ? "Operational" : "Unknown",
      note: sslConfigured ? "Store credentials configured." : "SSLCOMMERZ_STORE_ID not configured.",
    },
    {
      name: "Email",
      connected: 0,
      errors: 0,
      lastSync: null,
      status: mailConfigured ? "Operational" : "Unknown",
      note: `Provider: ${process.env["MAIL_PROVIDER"] ?? "log"}.`,
    },
    {
      name: "Background jobs",
      connected: jobs.length,
      errors: failedJobs,
      lastSync: null,
      status: failedJobs > 0 ? "Degraded" : "Operational",
      note: `${failedJobs} failed jobs need attention.`,
    },
  ];
}

export interface FbMonitor {
  connections: number;
  pages: number;
  forms: number;
  syncedLeads: number;
  failedSyncs: number;
  recentErrors: Array<{ businessId: string; error: string | null; at: string }>;
}

export async function getFacebookMonitor(): Promise<FbMonitor> {
  const [conns, pages, forms, events] = await Promise.all([
    allOrEmpty(MetaConnectionTable.select("id").all()),
    allOrEmpty(MetaPageTable.select("id").all()),
    allOrEmpty(MetaFormTable.select("id").all()),
    allOrEmpty(MetaLeadEventTable.select("id", "businessId", "status", "lastError", "updatedAt").all()),
  ]);
  const failed = events.filter((e) => e.status === "FAILED");
  const done = events.filter((e) => e.status === "DONE").length;
  return {
    connections: conns.length,
    pages: pages.length,
    forms: forms.length,
    syncedLeads: done,
    failedSyncs: failed.length,
    recentErrors: failed
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 10)
      .map((e) => ({ businessId: e.businessId, error: e.lastError, at: e.updatedAt })),
  };
}

export interface WaMonitor {
  connections: number;
  sent: number;
  failed: number;
  recentErrors: Array<{ businessId: string; error: string | null; at: string }>;
}

export async function getWhatsAppMonitor(): Promise<WaMonitor> {
  const [conns, messages] = await Promise.all([
    allOrEmpty(WhatsAppConnectionTable.select("id", "status").all()),
    allOrEmpty(WhatsAppMessageTable.select("id", "businessId", "status", "lastError", "updatedAt").all()),
  ]);
  const failed = messages.filter((m) => m.status === "FAILED");
  const sent = messages.filter((m) => ["SENT", "DELIVERED", "READ"].includes(m.status)).length;
  return {
    connections: conns.length,
    sent,
    failed: failed.length,
    recentErrors: failed
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 10)
      .map((e) => ({ businessId: e.businessId, error: e.lastError, at: e.updatedAt })),
  };
}
