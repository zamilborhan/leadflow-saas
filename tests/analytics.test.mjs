// Business analytics tests: pure aggregation math over Node type-stripping
// (analytics-core.ts has no project-local imports), plus HTTP end-to-end
// over a spawned dev server: KPIs, groupings, agent performance, follow-up
// completion, date/campaign filters, tenant isolation, and page rendering.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";
import {
  bucketLeadsByDay,
  dayBucket,
  groupByAd,
  groupByAdSet,
  groupByCampaign,
  groupBySource,
  leadInScope,
  rate,
  rollUpAgents,
  summarizeFollowUps,
  validateAnalyticsQuery,
} from "../src/lib/tenancy/analytics-core.ts";

const NOW = new Date("2026-09-09T12:00:00.000Z").getTime();
const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString();
const QUERY_30 = validateAnalyticsQuery({ days: "30" }, NOW);

function lead(over = {}) {
  return {
    id: "l1",
    status: "NEW",
    source: "facebook",
    campaignName: "Camp A",
    adSetName: "Set A",
    adName: "Ad A",
    assignedTo: null,
    createdAt: isoDay(NOW - 2 * DAY),
    ...over,
  };
}

describe("analytics query validation (pure)", () => {
  it("defaults to the last 30 days with no funnel filters", () => {
    const q = validateAnalyticsQuery({}, NOW);
    assert.equal(q.toDay, "2026-09-09");
    assert.equal(q.fromDay, "2026-08-11");
    assert.equal(q.campaign, "");
    assert.equal(q.adSet, "");
    assert.equal(q.ad, "");
  });

  it("honours day presets", () => {
    assert.equal(validateAnalyticsQuery({ days: "7" }, NOW).fromDay, "2026-09-03");
    assert.equal(validateAnalyticsQuery({ days: "14" }, NOW).fromDay, "2026-08-27");
    assert.equal(validateAnalyticsQuery({ days: "90" }, NOW).fromDay, "2026-06-12");
    assert.equal(validateAnalyticsQuery({ days: "banana" }, NOW).fromDay, "2026-08-11");
  });

  it("honours explicit from/to and swaps inverted ranges", () => {
    const q = validateAnalyticsQuery({ from: "2026-09-01", to: "2026-09-05" }, NOW);
    assert.deepEqual([q.fromDay, q.toDay], ["2026-09-01", "2026-09-05"]);
    const swapped = validateAnalyticsQuery({ from: "2026-09-05", to: "2026-09-01" }, NOW);
    assert.deepEqual([swapped.fromDay, swapped.toDay], ["2026-09-01", "2026-09-05"]);
  });

  it("rejects malformed dates and clamps absurd ranges", () => {
    assert.deepEqual(
      [validateAnalyticsQuery({ from: "not-a-date", to: "2026-09-05" }, NOW).fromDay, "2026-08-11"][0],
      "2026-08-11"
    );
    const wide = validateAnalyticsQuery({ from: "2001-01-01", to: "2026-09-09" }, NOW);
    assert.equal(wide.fromDay, "2025-09-10");
    const future = validateAnalyticsQuery({ from: "2026-09-20", to: "2026-09-25" }, NOW);
    assert.equal(future.toDay, "2026-09-09");
  });

  it("trims and caps funnel filters", () => {
    const q = validateAnalyticsQuery({ campaign: "  Camp ", adSet: "x".repeat(500), ad: "" }, NOW);
    assert.equal(q.campaign, "Camp");
    assert.equal(q.adSet.length, 200);
    assert.equal(q.ad, "");
  });
});

describe("analytics math (pure)", () => {
  it("rates round to 1 decimal and null on empty base", () => {
    assert.equal(rate(1, 3), 33.3);
    assert.equal(rate(2, 3), 66.7);
    assert.equal(rate(0, 5), 0);
    assert.equal(rate(0, 0), null);
    assert.equal(rate(3, -1), null);
  });

  it("buckets days and matches scope by range + funnel filters", () => {
    assert.equal(dayBucket("2026-09-09T00:00:00.000Z"), "2026-09-09");
    assert.equal(dayBucket("garbage"), null);
    assert.equal(leadInScope(lead(), QUERY_30), true);
    assert.equal(leadInScope(lead({ createdAt: isoDay(NOW - 60 * DAY) }), QUERY_30), false);
    assert.equal(
      leadInScope(lead(), { ...QUERY_30, campaign: "camp a" }),
      true,
      "campaign match is case-insensitive"
    );
    assert.equal(leadInScope(lead(), { ...QUERY_30, campaign: "camp b" }), false);
    assert.equal(leadInScope(lead({ campaignName: null }), { ...QUERY_30, campaign: "camp" }), false);
  });

  it("zero-fills daily buckets across the range", () => {
    const rows = [
      lead({ id: "a", createdAt: "2026-09-09T08:00:00.000Z" }),
      lead({ id: "b", createdAt: "2026-09-09T20:00:00.000Z" }),
      lead({ id: "c", createdAt: "2026-09-07T08:00:00.000Z" }),
      lead({ id: "old", createdAt: isoDay(NOW - 60 * DAY) }),
    ];
    const buckets = bucketLeadsByDay(rows, validateAnalyticsQuery({ days: "7" }, NOW));
    assert.equal(buckets.length, 7);
    assert.equal(buckets[0].day, "2026-09-03");
    assert.deepEqual(buckets[6], { day: "2026-09-09", count: 2 });
    assert.deepEqual(buckets[4], { day: "2026-09-07", count: 1 });
    assert.equal(buckets[0].count, 0);
  });

  it("groups funnel slices with conversion and Unknown fallback", () => {
    const rows = [
      lead({ id: "a", status: "CONVERTED" }),
      lead({ id: "b", status: "NEW" }),
      lead({ id: "c", status: "LOST", source: null }),
    ];
    assert.deepEqual(groupBySource(rows, QUERY_30), [
      { key: "facebook", count: 2, converted: 1, conversionRate: 50 },
      { key: "Unknown", count: 1, converted: 0, conversionRate: 0 },
    ]);
    assert.deepEqual(groupByCampaign(rows, QUERY_30), [
      { key: "Camp A", count: 3, converted: 1, conversionRate: 33.3 },
    ]);
    assert.deepEqual(groupByAdSet(rows, QUERY_30)[0].key, "Set A");
    assert.deepEqual(groupByAd(rows, QUERY_30)[0].key, "Ad A");
    assert.deepEqual(groupBySource([], QUERY_30), []);
  });

  it("rolls up agents by lead assignment with follow-up join", () => {
    const rows = [
      lead({ id: "a", status: "CONVERTED", assignedTo: "u1" }),
      lead({ id: "b", status: "NEW", assignedTo: "u1" }),
      lead({ id: "c", status: "NEW", assignedTo: "u2" }),
      lead({ id: "d", status: "NEW", assignedTo: null }),
    ];
    const fus = [
      { id: "f1", leadId: "a", assignedTo: "u9", scheduledAt: isoDay(NOW), status: "COMPLETED" },
      { id: "f2", leadId: "a", assignedTo: "u9", scheduledAt: isoDay(NOW), status: "PENDING" },
      { id: "f3", leadId: "d", assignedTo: null, scheduledAt: isoDay(NOW), status: "COMPLETED" },
      { id: "f4", leadId: "zzz", assignedTo: "u1", scheduledAt: isoDay(NOW), status: "COMPLETED" },
    ];
    // f3 is skipped (lead unassigned), f4 is skipped (lead out of scope).
    assert.deepEqual(rollUpAgents(rows, fus, QUERY_30), [
      {
        userId: "u1",
        assigned: 2,
        converted: 1,
        conversionRate: 50,
        followUpsCompleted: 1,
        followUpsTotal: 2,
        followUpCompletionRate: 50,
      },
      {
        userId: "u2",
        assigned: 1,
        converted: 0,
        conversionRate: 0,
        followUpsCompleted: 0,
        followUpsTotal: 0,
        followUpCompletionRate: null,
      },
    ]);
  });

  it("summarizes follow-up completion and overdue", () => {
    const rows = [lead({ id: "a" }), lead({ id: "b" })];
    const fus = [
      { id: "f1", leadId: "a", assignedTo: null, scheduledAt: isoDay(NOW - DAY), status: "COMPLETED" },
      { id: "f2", leadId: "a", assignedTo: null, scheduledAt: isoDay(NOW - DAY), status: "PENDING" },
      { id: "f3", leadId: "b", assignedTo: null, scheduledAt: isoDay(NOW + DAY), status: "PENDING" },
      { id: "f4", leadId: "b", assignedTo: null, scheduledAt: isoDay(NOW + DAY), status: "CANCELLED" },
      { id: "f5", leadId: "zzz", assignedTo: null, scheduledAt: isoDay(NOW), status: "COMPLETED" },
    ];
    assert.deepEqual(summarizeFollowUps(rows, fus, QUERY_30, NOW), {
      total: 4,
      completed: 1,
      pending: 3,
      overdue: 1,
      completionRate: 25,
    });
    assert.deepEqual(summarizeFollowUps([], [], QUERY_30, NOW).completionRate, null);
  });
});

// ---------------------------------------------------------------------------
// HTTP end-to-end: shared dev server (repo convention) with pg cleanup.
// ---------------------------------------------------------------------------

const ROOT = path.join(import.meta.dirname, "..");
// Shared dev servers first (repo convention is :4000; a project dev server
// may already hold :3000 and the single-server lock blocks spawning
// another). Fall back to a private spawn only when nothing answers.
const SHARED_PORTS = [4000, 3000];
const FALLBACK_PORT = 8095;
let PORT = SHARED_PORTS[0];
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `an${Date.now()}`;
let seq = 0;
let callNo = 0;

const testEmail = () => `${RUN_TAG}+${seq++}@example.invalid`;
const PASSWORD = "correct horse battery staple 12";

function loadDotEnv() {
  const out = {};
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

function pg() {
  return new Client({ connectionString: loadDotEnv().DATABASE_URL });
}

function sessionCookieFrom(res) {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/lf_session=([^;]*)/);
  return m ? `lf_session=${m[1]}` : null;
}

async function api(method, urlPath, { body, cookie } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (cookie) headers.cookie = cookie;
  callNo += 1;
  headers["x-forwarded-for"] = `10.98.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
  const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: payload, redirect: "manual" });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, cookie: sessionCookieFrom(res) };
}

async function getHtml(urlPath, cookie) {
  callNo += 1;
  const res = await fetch(`${BASE}${urlPath}`, {
    headers: {
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": `10.98.${Math.floor(callNo / 250) % 250}.${callNo % 250}`,
    },
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location"), html: await res.text() };
}

let server = null;
let ownServer = false;

async function isPortOpen(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port }, () => {
      s.end();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs) {
  const start = Date.now();
  for (;;) {
    if (await isPortOpen(port)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`dev server did not open port ${port}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

before(async () => {
  for (const port of SHARED_PORTS) {
    if (await isPortOpen(port)) {
      PORT = port;
      BASE = `http://127.0.0.1:${PORT}`;
      ownServer = false;
      return;
    }
  }
  PORT = FALLBACK_PORT;
  BASE = `http://127.0.0.1:${PORT}`;
  server = spawn("node", ["node_modules/next/dist/bin/next", "dev", "--port", String(PORT)], {
    cwd: ROOT,
    stdio: "ignore",
  });
  ownServer = true;
  await waitForPort(PORT, 120_000);
}, { timeout: 150_000 });

after(async () => {
  if (server && ownServer) {
    server.kill();
    server = null;
  }
  const client = pg();
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT id FROM "User" WHERE email LIKE '${RUN_TAG}%'`);
    const userIds = rows.map((r) => r.id);
    const biz = await client.query(`SELECT id FROM "Business" WHERE name LIKE '${RUN_TAG}%'`);
    const bizIds = biz.rows.map((r) => r.id);
    if (bizIds.length > 0) {
      await client.query(`DELETE FROM "FollowUp" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "LeadActivity" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "LeadNote" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "Lead" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "BusinessMember" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "Business" WHERE id = ANY($1)`, [bizIds]);
    }
    if (userIds.length > 0) {
      await client.query(`DELETE FROM "PasswordResetToken" WHERE "userId" = ANY($1)`, [userIds]);
      await client.query(`DELETE FROM "Session" WHERE "userId" = ANY($1)`, [userIds]);
      await client.query(`DELETE FROM "BusinessMember" WHERE "userId" = ANY($1)`, [userIds]);
      await client.query(`DELETE FROM "User" WHERE id = ANY($1)`, [userIds]);
    }
  } finally {
    await client.end();
  }
}, { timeout: 60_000 });

async function registerAndLogin() {
  const email = testEmail();
  const reg = await api("POST", "/api/auth/register", { body: { email, password: PASSWORD } });
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.json)}`);
  const login = await api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.ok(login.cookie);
  return { email, cookie: login.cookie };
}

async function createBusiness(cookie, name, plan = "STARTER") {
  const r = await api("POST", "/api/businesses", { body: { name }, cookie });
  assert.equal(r.status, 201, `create business failed: ${JSON.stringify(r.json)}`);
  // Quota context: these tests invite a second member, which exceeds FREE.
  if (plan) {
    const s = await api("PATCH", `/api/businesses/${r.json.business.id}/subscription`, {
      body: { planCode: plan },
      cookie,
    });
    assert.equal(s.status, 200, `set plan failed: ${JSON.stringify(s.json)}`);
  }
  return r.json.business;
}

async function userIdByEmail(email) {
  const client = pg();
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT id FROM "User" WHERE email = $1`, [email]);
    assert.equal(rows.length, 1, `expected one user for ${email}`);
    return rows[0].id;
  } finally {
    await client.end();
  }
}

async function invite(cookie, businessId, email, role) {
  const r = await api("POST", `/api/businesses/${businessId}/members`, {
    body: { email, role },
    cookie,
  });
  assert.equal(r.status, 201, `invite ${role} failed: ${JSON.stringify(r.json)}`);
}

async function createLead(cookie, businessId, name, extra = {}) {
  const r = await api("POST", `/api/businesses/${businessId}/leads`, {
    body: { name, ...extra },
    cookie,
  });
  assert.equal(r.status, 201, `create lead failed: ${JSON.stringify(r.json)}`);
  return r.json.lead;
}

// Default NEW_LEAD automations would reassign leads and schedule extra
// follow-ups — disable every rule so fixtures stay exactly as created.
async function disableAutomations(cookie, businessId) {
  const list = await api("GET", `/api/businesses/${businessId}/automations/rules`, { cookie });
  assert.equal(list.status, 200, `list rules failed: ${JSON.stringify(list.json)}`);
  for (const rule of list.json.rules) {
    const patched = await api("PATCH", `/api/businesses/${businessId}/automations/rules/${rule.id}`, {
      body: { status: "DISABLED" },
      cookie,
    });
    assert.equal(patched.status, 200, `disable rule failed: ${JSON.stringify(patched.json)}`);
  }
}

async function clearFollowUps(cookie, businessId) {
  const list = await api("GET", `/api/businesses/${businessId}/followups?scope=all`, { cookie });
  assert.equal(list.status, 200, `list follow-ups failed: ${JSON.stringify(list.json)}`);
  for (const fu of list.json.followUps) {
    const del = await api("DELETE", `/api/businesses/${businessId}/followups/${fu.id}`, { cookie });
    assert.equal(del.status, 200, `delete follow-up failed: ${JSON.stringify(del.json)}`);
  }
}

const HOUR = 3600_000;

describe("analytics API tenant scoping", () => {
  it("reports per-business metrics, filters, and isolates tenants", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const stranger = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} metrics`);
    const bizOther = await createBusiness(stranger.cookie, `${RUN_TAG} other`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    await disableAutomations(owner.cookie, biz.id);
    const salesId = await userIdByEmail(sales.email);
    const ownerId = await userIdByEmail(owner.email);

    // Deterministic funnel: 2 converted (Camp A), 1 open (Camp A), 1 open (Camp B, sales).
    const l1 = await createLead(owner.cookie, biz.id, `${RUN_TAG} won-a`, {
      status: "CONVERTED", source: "facebook", campaignName: `${RUN_TAG} Camp A`,
      adSetName: `${RUN_TAG} Set A`, adName: `${RUN_TAG} Ad A`, assignedTo: ownerId,
    });
    await createLead(owner.cookie, biz.id, `${RUN_TAG} won-b`, {
      status: "CONVERTED", source: "website", campaignName: `${RUN_TAG} Camp A`,
      adSetName: `${RUN_TAG} Set A`, adName: `${RUN_TAG} Ad B`, assignedTo: salesId,
    });
    const l3 = await createLead(owner.cookie, biz.id, `${RUN_TAG} open-a`, {
      status: "NEW", source: "facebook", campaignName: `${RUN_TAG} Camp A`,
      adSetName: `${RUN_TAG} Set B`, adName: `${RUN_TAG} Ad C`, assignedTo: salesId,
    });
    const l4 = await createLead(owner.cookie, biz.id, `${RUN_TAG} open-b`, {
      status: "INTERESTED", source: "referral", campaignName: `${RUN_TAG} Camp B`,
      assignedTo: salesId,
    });
    await createLead(stranger.cookie, bizOther.id, `${RUN_TAG} foreign`, { status: "CONVERTED" });

    // Backdate two leads so day buckets spread (test-only pg tweak).
    const backdate = pg();
    await backdate.connect();
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * HOUR).toISOString();
      await backdate.query(`UPDATE "Lead" SET "createdAt" = $1 WHERE id = $2`, [threeDaysAgo, l4.id]);
    } finally {
      await backdate.end();
    }

    // Automation may have scheduled follow-ups on lead creation — clear them,
    // then schedule exactly: 1 completed (owner), 1 pending future (sales),
    // 1 overdue (sales).
    await clearFollowUps(owner.cookie, biz.id);
    const mkFu = async (leadId, scheduledAt, extra = {}) => {
      const r = await api("POST", `/api/businesses/${biz.id}/leads/${leadId}/followups`, {
        body: { scheduledAt, ...extra },
        cookie: owner.cookie,
      });
      assert.equal(r.status, 201, `schedule failed: ${JSON.stringify(r.json)}`);
      return r.json.followUp;
    };
    const done = await mkFu(l1.id, new Date(Date.now() - 2 * HOUR).toISOString());
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/followups/${done.id}`, {
        body: { status: "COMPLETED" }, cookie: owner.cookie,
      })).status, 200);
    await mkFu(l3.id, new Date(Date.now() + 24 * HOUR).toISOString(), { assignedTo: salesId });
    await mkFu(l4.id, new Date(Date.now() - 24 * HOUR).toISOString(), { assignedTo: salesId });

    const res = await api("GET", `/api/businesses/${biz.id}/analytics?days=30`, { cookie: owner.cookie });
    assert.equal(res.status, 200, `analytics failed: ${JSON.stringify(res.json)}`);
    const a = res.json.analytics;

    // KPIs.
    assert.equal(a.kpis.totalLeads, 4);
    assert.equal(a.kpis.convertedLeads, 2);
    assert.equal(a.kpis.conversionRate, 50);
    assert.equal(a.kpis.followUpCompletion.total, 3);
    assert.equal(a.kpis.followUpCompletion.completed, 1);
    assert.equal(a.kpis.followUpCompletion.completionRate, 33.3);
    assert.equal(a.kpis.overdueFollowUps, 1);

    // Funnel groupings.
    const campA = a.leadsByCampaign.find((s) => s.key === `${RUN_TAG} Camp A`);
    assert.deepEqual(campA, { key: `${RUN_TAG} Camp A`, count: 3, converted: 2, conversionRate: 66.7 });
    const fb = a.leadsBySource.find((s) => s.key === "facebook");
    assert.equal(fb.count, 2);
    const setA = a.leadsByAdSet.find((s) => s.key === `${RUN_TAG} Set A`);
    assert.equal(setA.count, 2);
    const adB = a.leadsByAd.find((s) => s.key === `${RUN_TAG} Ad B`);
    assert.deepEqual(adB, { key: `${RUN_TAG} Ad B`, count: 1, converted: 1, conversionRate: 100 });

    // Day buckets: today has 3, three-days-ago has 1.
    const today = new Date().toISOString().slice(0, 10);
    const threeAgo = new Date(Date.now() - 3 * 24 * HOUR).toISOString().slice(0, 10);
    assert.equal(a.leadsByDay.find((b) => b.day === today).count, 3);
    assert.equal(a.leadsByDay.find((b) => b.day === threeAgo).count, 1);

    // Agent performance.
    const salesRow = a.agents.find((x) => x.userId === salesId);
    assert.equal(salesRow.assigned, 3);
    assert.equal(salesRow.converted, 1);
    assert.equal(salesRow.conversionRate, 33.3);
    assert.equal(salesRow.followUpsCompleted, 0);
    assert.equal(salesRow.followUpsTotal, 2);
    assert.equal(salesRow.followUpCompletionRate, 0);
    assert.equal(salesRow.email, sales.email);
    const ownerRow = a.agents.find((x) => x.userId === ownerId);
    assert.equal(ownerRow.assigned, 1);
    assert.equal(ownerRow.followUpsCompleted, 1);

    // Campaign filter narrows everything consistently.
    const filtered = await api(
      "GET", `/api/businesses/${biz.id}/analytics?days=30&campaign=${encodeURIComponent(`${RUN_TAG} Camp B`)}`,
      { cookie: owner.cookie }
    );
    assert.equal(filtered.status, 200);
    assert.equal(filtered.json.analytics.kpis.totalLeads, 1);
    assert.equal(filtered.json.analytics.leadsByCampaign.length, 1);

    // Date filter excludes the backdated lead.
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayOnly = await api(
      "GET", `/api/businesses/${biz.id}/analytics?from=${todayStr}&to=${todayStr}`,
      { cookie: owner.cookie }
    );
    assert.equal(todayOnly.json.analytics.kpis.totalLeads, 3);

    // Sales role can read its own workspace analytics.
    const asSales = await api("GET", `/api/businesses/${biz.id}/analytics?days=30`, { cookie: sales.cookie });
    assert.equal(asSales.status, 200);
    assert.equal(asSales.json.analytics.kpis.totalLeads, 4);

    // Tenant isolation: stranger's workspace is untouched and invisible here.
    const other = await api("GET", `/api/businesses/${bizOther.id}/analytics?days=30`, { cookie: stranger.cookie });
    assert.equal(other.json.analytics.kpis.totalLeads, 1);
    assert.ok(!JSON.stringify(other.json).includes(`${RUN_TAG} Camp A`), "cross-tenant campaign leaked");
    const cross = await api("GET", `/api/businesses/${biz.id}/analytics?days=30`, { cookie: stranger.cookie });
    assert.equal(cross.status, 403);
    const anon = await api("GET", `/api/businesses/${biz.id}/analytics?days=30`);
    assert.equal(anon.status, 401);
  });
});

describe("analytics page rendering", () => {
  it("renders KPIs, charts, filters, and agent rows scoped to the workspace", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} page`);
    await disableAutomations(owner.cookie, biz.id);
    const ownerId = await userIdByEmail(owner.email);
    await createLead(owner.cookie, biz.id, `${RUN_TAG} page-lead`, {
      status: "CONVERTED", source: "facebook", campaignName: `${RUN_TAG} Page Camp`, assignedTo: ownerId,
    });

    const page = await getHtml(`/dashboard/analytics?businessId=${biz.id}&days=30`, owner.cookie);
    assert.equal(page.status, 200, `analytics page failed with ${page.status}`);
    for (const needle of [
      "Analytics", "Total leads", "Converted leads", "Conversion rate",
      "Follow-up completion", "Overdue follow-ups", "Leads by day",
      "Leads by source", "Leads by campaign", "Leads by ad set", "Leads by ad",
      "Sales-agent performance", "Date range", "Campaign",
      `${RUN_TAG} Page Camp`, "50", "100",
    ]) {
      assert.ok(page.html.includes(needle), `analytics page missing ${JSON.stringify(needle)}`);
    }

    // Filters narrow the rendered numbers.
    const filtered = await getHtml(
      `/dashboard/analytics?businessId=${biz.id}&days=30&campaign=${encodeURIComponent("no-such-campaign")}`,
      owner.cookie
    );
    assert.equal(filtered.status, 200);
    assert.ok(filtered.html.includes("No leads in this range"), "filtered empty state missing");

    // Foreign workspace falls back without leaking.
    const stranger = await registerAndLogin();
    const foreign = await getHtml(`/dashboard/analytics?businessId=${biz.id}`, stranger.cookie);
    assert.equal(foreign.status, 200);
    assert.ok(!foreign.html.includes(`${RUN_TAG} page-lead`), "analytics page leaked cross-tenant lead");
  });

  it("shows the empty state for fresh workspaces", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} empty`);
    await disableAutomations(owner.cookie, biz.id);
    const page = await getHtml(`/dashboard/analytics?businessId=${biz.id}`, owner.cookie);
    assert.equal(page.status, 200);
    assert.ok(page.html.includes("Total leads"), "missing KPI cards");
    assert.ok(page.html.includes("No leads in this range"), "missing empty chart state");
    assert.ok(page.html.includes("No agent activity yet"), "missing empty agent state");
  });
});
