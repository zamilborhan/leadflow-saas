// SaaS subscription management tests.
//
// Unit layer (pure catalog only — direct .ts import works with Node
// type-stripping; catalog.ts has no project-local imports): plan limits,
// cycle math, patch validation.
// HTTP layer (dedicated dev server with META_GRAPH_BASE_URL pointed at an
// in-test mock Graph API): default FREE subscription + usage, lead cap with
// bypass attempts, webhook ingestion cap, member cap, plan upgrade/
// downgrade, cancel/past-due blocking, renewal rollover, AGENCY
// multi-workspace, tenant isolation, and role gating.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";
import {
  BILLING_CYCLES,
  DEFAULT_PLAN_CODE,
  PLANS,
  PLAN_CODES,
  SUBSCRIPTION_STATUSES,
  addOneMonth,
  isValidPlanCode,
  isValidSubscriptionStatus,
  monthBounds,
  rollPeriod,
  validateSubscriptionPatch,
} from "../src/lib/billing/catalog.ts";

describe("billing catalog (pure)", () => {
  it("defines exactly the five required plans", () => {
    assert.deepEqual([...PLAN_CODES], ["FREE", "STARTER", "GROWTH", "BUSINESS", "AGENCY"]);
    assert.equal(DEFAULT_PLAN_CODE, "FREE");
    assert.equal(isValidPlanCode("STARTER"), true);
    assert.equal(isValidPlanCode("free"), false);
    assert.equal(isValidPlanCode("ENTERPRISE"), false);
    assert.equal(isValidPlanCode(null), false);
  });

  it("encodes the specified lead and user limits", () => {
    assert.deepEqual(
      [PLANS.FREE.leadsPerMonth, PLANS.FREE.maxUsers],
      [50, 1]
    );
    assert.deepEqual(
      [PLANS.STARTER.leadsPerMonth, PLANS.STARTER.maxUsers],
      [500, 2]
    );
    assert.deepEqual(
      [PLANS.GROWTH.leadsPerMonth, PLANS.GROWTH.maxUsers],
      [2000, 5]
    );
    assert.deepEqual(
      [PLANS.BUSINESS.leadsPerMonth, PLANS.BUSINESS.maxUsers],
      [10000, 15]
    );
  });

  it("grants multiple workspaces only to AGENCY", () => {
    for (const code of ["FREE", "STARTER", "GROWTH", "BUSINESS"]) {
      assert.equal(PLANS[code].maxBusinesses, 1, code);
    }
    assert.equal(PLANS.AGENCY.maxBusinesses, null);
  });

  it("supports ACTIVE, PAST_DUE, CANCELED statuses and MONTHLY billing", () => {
    assert.deepEqual([...SUBSCRIPTION_STATUSES], ["ACTIVE", "PAST_DUE", "CANCELED"]);
    assert.deepEqual([...BILLING_CYCLES], ["MONTHLY"]);
    assert.equal(isValidSubscriptionStatus("ACTIVE"), true);
    assert.equal(isValidSubscriptionStatus("TRIALING"), false);
    assert.equal(isValidSubscriptionStatus(""), false);
  });

  it("computes UTC calendar-month bounds", () => {
    assert.deepEqual(monthBounds(new Date("2026-09-15T12:00:00Z").getTime()), {
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-10-01T00:00:00.000Z",
    });
    assert.deepEqual(monthBounds(new Date("2026-12-31T23:59:59Z").getTime()), {
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    });
    assert.equal(addOneMonth("2026-01-15T00:00:00.000Z"), "2026-02-01T00:00:00.000Z");
  });

  it("rolls elapsed periods forward to the containing month", () => {
    const now = new Date("2026-09-09T09:00:00Z").getTime();
    assert.deepEqual(rollPeriod("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", now), {
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-10-01T00:00:00.000Z",
    });
    assert.deepEqual(rollPeriod("2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", now), {
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-10-01T00:00:00.000Z",
    });
  });

  it("validates owner patch payloads without accepting caller limits", () => {
    assert.deepEqual(validateSubscriptionPatch({ planCode: "GROWTH" }), {
      ok: true,
      value: { planCode: "GROWTH" },
      errors: {},
    });
    assert.deepEqual(validateSubscriptionPatch({ status: "CANCELED" }).ok, true);
    assert.equal(validateSubscriptionPatch({ planCode: "ENTERPRISE" }).ok, false);
    assert.equal(validateSubscriptionPatch({ planCode: "FREE", leadsPerMonth: 999999 }).ok, false);
    assert.equal(validateSubscriptionPatch({ status: "TRIALING" }).ok, false);
    assert.equal(validateSubscriptionPatch({}).ok, false);
    assert.equal(validateSubscriptionPatch(null).ok, false);
    assert.equal(validateSubscriptionPatch("GROWTH").ok, false);
  });
});

const ROOT = path.join(import.meta.dirname, "..");
// Shared dev server (:4000 repo convention) when available; otherwise a
// private spawn with META_GRAPH_BASE_URL pointed at the in-test mock
// Graph API so the Meta webhook ingestion path stays deterministic.
const FALLBACK_PORT = 8100;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `bill${Date.now()}`;
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

function nextIp() {
  callNo += 1;
  return `10.99.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
}

async function api(method, urlPath, { body, cookie } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (cookie) headers.cookie = cookie;
  headers["x-forwarded-for"] = nextIp();
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
  const res = await fetch(`${BASE}${urlPath}`, {
    headers: { ...(cookie ? { cookie } : {}), "x-forwarded-for": nextIp() },
    redirect: "manual",
  });
  return { status: res.status, headers: res.headers, html: await res.text() };
}

let server = null;
let ownServer = false;

function leadDetailsPayload(leadgenId) {
  return {
    id: leadgenId,
    field_data: [
      { name: "full_name", values: [`${RUN_TAG} webhook prospect`] },
      { name: "email", values: [`webhook-${RUN_TAG}@example.com`] },
      { name: "phone_number", values: ["+880170000099"] },
    ],
  };
}

let mockServer = null;
let mockPort = 0;

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
  if (!(await isPortOpen(PORT))) {
    PORT = FALLBACK_PORT;
    BASE = `http://127.0.0.1:${PORT}`;
    ownServer = true;
  }
  mockServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const send = (payload, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const leadMatch = url.pathname.match(/^\/v26\.0\/([A-Za-z0-9_-]+)$/);
    if (req.method === "GET" && leadMatch) {
      send(leadDetailsPayload(leadMatch[1]));
      return;
    }
    send({ error: { message: "Unsupported mock request.", code: 100 } }, 400);
  });
  await new Promise((resolve, reject) => {
    mockServer.on("error", reject);
    mockServer.listen(0, "127.0.0.1", resolve);
  });
  mockPort = mockServer.address().port;

  const dotEnv = loadDotEnv();
  if (ownServer) {
    server = spawn("node", ["node_modules/next/dist/bin/next", "dev", "--port", String(PORT)], {
      cwd: ROOT,
      stdio: "ignore",
      env: {
        ...process.env,
        ...dotEnv,
        META_GRAPH_BASE_URL: `http://127.0.0.1:${mockPort}/v26.0`,
      },
    });
  }
  await waitForPort(PORT, 180_000);
}, { timeout: 200_000 });

after(async () => {
  if (server) {
    server.kill();
    server = null;
  }
  if (mockServer) {
    await new Promise((resolve) => mockServer.close(() => resolve()));
    mockServer = null;
  }
  const client = pg();
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT id FROM "User" WHERE email LIKE '${RUN_TAG}%'`);
    const userIds = rows.map((r) => r.id);
    const biz = await client.query(`SELECT id FROM "Business" WHERE name LIKE '${RUN_TAG}%'`);
    const bizIds = biz.rows.map((r) => r.id);
    if (bizIds.length > 0) {
      await client.query(`DELETE FROM "Subscription" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "Notification" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "MetaLeadEvent" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "MetaForm" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "MetaPage" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "MetaConnection" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "FollowUp" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "LeadActivity" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "LeadNote" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "Lead" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "BusinessMember" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "Business" WHERE id = ANY($1)`, [bizIds]);
    }
    if (userIds.length > 0) {
      await client.query(`DELETE FROM "EmailVerificationToken" WHERE "userId" = ANY($1)`, [userIds]);
      await client.query(`DELETE FROM "OAuthAccount" WHERE "userId" = ANY($1)`, [userIds]);
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
  assert.ok(reg.json.businessId, "register must return the auto-created businessId");
  const login = await api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.ok(login.cookie);
  return { email, cookie: login.cookie, businessId: reg.json.businessId };
}

async function createBusiness(cookie, name) {
  // Registration auto-creates the workspace (FREE quota); adopt it.
  // `name` is kept for call-site parity.
  void name;
  const list = await api("GET", "/api/businesses", { cookie });
  assert.equal(list.status, 200);
  assert.ok(list.json.businesses.length >= 1, "expected auto-created workspace");
  return list.json.businesses[0];
}

async function setPlan(cookie, businessId, planCode) {
  const r = await api("PATCH", `/api/businesses/${businessId}/subscription`, {
    body: { planCode },
    cookie,
  });
  assert.equal(r.status, 200, `set plan ${planCode} failed: ${JSON.stringify(r.json)}`);
  return r.json;
}

async function subscriptionOf(businessId) {
  const client = pg();
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT * FROM "Subscription" WHERE "businessId" = $1`, [businessId]);
    return rows[0] ?? null;
  } finally {
    await client.end();
  }
}

async function dbRows(sql, params) {
  const client = pg();
  await client.connect();
  try {
    const { rows } = await client.query(sql, params);
    return rows;
  } finally {
    await client.end();
  }
}

async function dbExec(sql, params) {
  const client = pg();
  await client.connect();
  try {
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/** Seed Meta connection + page + form directly (bypasses Meta entirely). */
async function seedMetaStack(businessId, formId, pageId) {
  const keyRaw = loadDotEnv().META_TOKEN_KEY;
  const { encryptToken: enc } = await import("../src/lib/integrations/meta/crypto.ts");
  const ciphertext = await enc(`EAA-seed-${RUN_TAG}`, keyRaw);
  const { randomUUID } = await import("node:crypto");
  await dbExec(
    `INSERT INTO "MetaConnection"
        ("id", "businessId", "metaUserId", "metaUserName", "accessTokenEncrypted", "scopes", "status", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', NOW())`,
    [randomUUID(), businessId, `meta-user-${RUN_TAG}`, `Seed Owner ${RUN_TAG}`, ciphertext, "pages_show_list leads_retrieval"]
  );
  await dbExec(
    `INSERT INTO "MetaPage"
      ("id", "businessId", "metaPageId", "name", "pageTokenEncrypted", "tasks", "selectedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
    [randomUUID(), businessId, pageId, `Seed Page ${RUN_TAG}`, ciphertext, "ADVERTISE MANAGE"]
  );
  await dbExec(
    `INSERT INTO "MetaForm"
      ("id", "businessId", "metaPageId", "metaFormId", "name", "status", "connectedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
    [randomUUID(), businessId, pageId, formId, `Seed Form ${RUN_TAG}`, "ACTIVE"]
  );
}

function webhookPayload(leadgenId, formId, pageId) {
  return {
    object: "page",
    entry: [
      {
        id: pageId,
        time: 1757320000,
        changes: [
          {
            field: "leadgen",
            value: {
              leadgen_id: leadgenId,
              page_id: pageId,
              form_id: formId,
              adgroup_id: `adset-${RUN_TAG}`,
              ad_id: `ad-${RUN_TAG}`,
              created_time: 1757320000,
            },
          },
        ],
      },
    ],
  };
}

async function postWebhook(payloadObject) {
  const rawBody = JSON.stringify(payloadObject);
  const secret = loadDotEnv().META_APP_SECRET;
  const headers = {
    "content-type": "application/json",
    "x-forwarded-for": nextIp(),
    "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`,
  };
  const res = await fetch(`${BASE}/api/webhooks/meta`, {
    method: "POST",
    headers,
    body: rawBody,
    redirect: "manual",
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

describe("subscription defaults and reads", () => {
  it("provisions FREE/ACTIVE with live usage and isolates tenants", async () => {
    const owner = await registerAndLogin();
    const outsider = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} defaults`);

    const res = await api("GET", `/api/businesses/${biz.id}/subscription`, { cookie: owner.cookie });
    assert.equal(res.status, 200, `subscription read failed: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.subscription.planCode, "FREE");
    assert.equal(res.json.subscription.status, "ACTIVE");
    assert.equal(res.json.subscription.billingCycle, "MONTHLY");
    assert.ok(res.json.subscription.currentPeriodEnd > res.json.subscription.currentPeriodStart);
    assert.equal(res.json.subscription.currentPeriodEnd, res.json.usage.renewalDate);
    assert.deepEqual([res.json.plan.leadsPerMonth, res.json.plan.maxUsers], [50, 1]);
    assert.deepEqual([res.json.usage.leadsUsed, res.json.usage.membersUsed], [0, 1]);
    assert.equal(res.json.plans.length, 5);

    // Cross-tenant reads and anonymous reads are denied without leakage.
    assert.equal(
      (await api("GET", `/api/businesses/${biz.id}/subscription`, { cookie: outsider.cookie })).status,
      403
    );
    assert.equal((await api("GET", `/api/businesses/${biz.id}/subscription`)).status, 401);
  });
});

describe("lead quota enforcement", () => {
  it("blocks the 51st lead on FREE and resists bypass shapes", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} leadcap`);
    for (let i = 0; i < 50; i++) {
      const r = await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: `${RUN_TAG} lead ${i}` },
        cookie: owner.cookie,
      });
      assert.equal(r.status, 201, `lead ${i} failed: ${JSON.stringify(r.json)}`);
    }
    const over = await api("POST", `/api/businesses/${biz.id}/leads`, {
      body: { name: `${RUN_TAG} lead 51` },
      cookie: owner.cookie,
    });
    assert.equal(over.status, 402, `expected 402, got ${over.status}: ${JSON.stringify(over.json)}`);
    assert.match(over.json.error, /limit/i);

    // Bypass attempts: every payload shape hits the same server-side gate.
    const bypassBodies = [
      { name: `${RUN_TAG} x1`, source: "facebook", status: "CONVERTED" },
      { name: `${RUN_TAG} x2`, phone: "+880170000001" },
      { name: `${RUN_TAG} x3`, facebookLeadId: `fb-${RUN_TAG}-x3` },
      { name: `${RUN_TAG} x4`, campaignName: " tentando ", planCode: "AGENCY", leadsPerMonth: 999999 },
      { name: "x", email: "x@example.com" },
    ];
    for (const [i, body] of bypassBodies.entries()) {
      const r = await api("POST", `/api/businesses/${biz.id}/leads`, { body, cookie: owner.cookie });
      assert.equal(r.status, 402, `bypass ${i} not blocked: ${r.status} ${JSON.stringify(r.json)}`);
    }

    // Usage reflects the cap; upgrade reopens intake.
    const usage = await api("GET", `/api/businesses/${biz.id}/subscription`, { cookie: owner.cookie });
    assert.equal(usage.json.usage.leadsUsed, 50);
    await setPlan(owner.cookie, biz.id, "STARTER");
    const afterUpgrade = await api("POST", `/api/businesses/${biz.id}/leads`, {
      body: { name: `${RUN_TAG} lead 51` },
      cookie: owner.cookie,
    });
    assert.equal(afterUpgrade.status, 201, `post-upgrade lead failed: ${JSON.stringify(afterUpgrade.json)}`);
  });
});

describe("webhook ingestion quota", () => {
  it("rejects Meta-ingested leads over quota without retrying", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} webhookcap`);
    const formId = `form-${RUN_TAG}-cap`;
    const pageId = `page-${RUN_TAG}-cap`;
    await seedMetaStack(biz.id, formId, pageId);
    for (let i = 0; i < 50; i++) {
      const r = await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: `${RUN_TAG} w${i}` },
        cookie: owner.cookie,
      });
      assert.equal(r.status, 201, `lead ${i} failed`);
    }
    const res = await postWebhook(webhookPayload(`lg-${RUN_TAG}-over-quota`, formId, pageId));
    assert.equal(res.status, 200, `webhook failed: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.created, 0, "over-quota webhook must not create a lead");
    // Terminal failures land in the deferred bucket (processed, no retry);
    // the row below proves no retry was scheduled.
    assert.equal(res.json.deferred, 1);
    const events = await dbRows(
      `SELECT status, "lastError", "nextRetryAt" FROM "MetaLeadEvent" WHERE "businessId" = $1`,
      [biz.id]
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "FAILED");
    assert.match(events[0].lastError, /limit/i);
    assert.equal(events[0].nextRetryAt, null, "quota failures must not schedule retries");
    const leads = await dbRows(`SELECT COUNT(*)::int AS n FROM "Lead" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(leads[0].n, 50);
  });
});

describe("member quota enforcement", () => {
  it("blocks the second member on FREE and opens up on STARTER", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const extra = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} teamcap`);

    // Invalid payloads still 422 (validation precedes quota).
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email: "", role: "SALES" },
        cookie: owner.cookie,
      })).status,
      422
    );

    const blocked = await api("POST", `/api/businesses/${biz.id}/members`, {
      body: { email: sales.email, role: "SALES" },
      cookie: owner.cookie,
    });
    assert.equal(blocked.status, 402, `expected 402, got ${blocked.status}: ${JSON.stringify(blocked.json)}`);
    assert.match(blocked.json.error, /limit/i);

    await setPlan(owner.cookie, biz.id, "STARTER");
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email: sales.email, role: "SALES" },
        cookie: owner.cookie,
      })).status,
      201
    );
    // STARTER allows exactly 2: the third invite fails.
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email: extra.email, role: "SALES" },
        cookie: owner.cookie,
      })).status,
      402
    );
  });
});

describe("plan and status changes", () => {
  it("is OWNER-only, validates codes, and blocks writes when inactive", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} planchange`);
    await setPlan(owner.cookie, biz.id, "STARTER");
    await api("POST", `/api/businesses/${biz.id}/members`, {
      body: { email: sales.email, role: "SALES" },
      cookie: owner.cookie,
    });

    // SALES and ADMIN-adjacent callers cannot touch billing.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/subscription`, {
        body: { planCode: "AGENCY" },
        cookie: sales.cookie,
      })).status,
      403
    );
    // Unknown codes and fields are rejected, never stored.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/subscription`, {
        body: { planCode: "ENTERPRISE" },
        cookie: owner.cookie,
      })).status,
      422
    );
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/subscription`, {
        body: { leadsPerMonth: 999999 },
        cookie: owner.cookie,
      })).status,
      422
    );
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/subscription`, { body: {}, cookie: owner.cookie })).status,
      422
    );
    const unchanged = await api("GET", `/api/businesses/${biz.id}/subscription`, { cookie: owner.cookie });
    assert.equal(unchanged.json.subscription.planCode, "STARTER");

    // Cancel blocks writes but keeps reads.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/subscription`, {
        body: { status: "CANCELED" },
        cookie: owner.cookie,
      })).status,
      200
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: `${RUN_TAG} canceled lead` },
        cookie: owner.cookie,
      })).status,
      402
    );
    assert.equal(
      (await api("GET", `/api/businesses/${biz.id}/subscription`, { cookie: owner.cookie })).status,
      200
    );
    // Reactivate reopens writes.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/subscription`, {
        body: { status: "ACTIVE" },
        cookie: owner.cookie,
      })).status,
      200
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: `${RUN_TAG} reactivated lead` },
        cookie: owner.cookie,
      })).status,
      201
    );
  });

  it("flags PAST_DUE, blocks writes, and notifies managers", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} pastdue`);
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/subscription`, {
        body: { status: "PAST_DUE" },
        cookie: owner.cookie,
      })).status,
      200
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: `${RUN_TAG} pastdue lead` },
        cookie: owner.cookie,
      })).status,
      402
    );
    const client = pg();
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT type, title FROM "Notification" WHERE "businessId" = $1 AND type = 'PAYMENT_FAILED'`,
        [biz.id]
      );
      assert.equal(rows.length, 1, `expected one PAYMENT_FAILED notification, got ${rows.length}`);
    } finally {
      await client.end();
    }
  });
});

describe("billing cycle renewal", () => {
  it("rolls the period forward and resets usage", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} renewal`);
    for (let i = 0; i < 50; i++) {
      const r = await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: `${RUN_TAG} r${i}` },
        cookie: owner.cookie,
      });
      assert.equal(r.status, 201, `lead ${i} failed`);
    }
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: `${RUN_TAG} capped` },
        cookie: owner.cookie,
      })).status,
      402
    );
    // Backdate the period into last month (simulates month turnover) and
    // age the consumed leads with it, so the new cycle starts empty.
    const before = await subscriptionOf(biz.id);
    assert.ok(before);
    const now = new Date();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const midLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const client = pg();
    await client.connect();
    try {
      await client.query(`UPDATE "Lead" SET "createdAt" = $1 WHERE "businessId" = $2`, [
        midLastMonth.toISOString(),
        biz.id,
      ]);
      await client.query(
        `UPDATE "Subscription" SET "currentPeriodStart" = $1, "currentPeriodEnd" = $2 WHERE id = $3`,
        [lastMonth.toISOString(), thisMonth.toISOString(), before.id]
      );
    } finally {
      await client.end();
    }
    // Next read rolls the cycle: renewal advances, usage resets, writes reopen.
    const after = await api("GET", `/api/businesses/${biz.id}/subscription`, { cookie: owner.cookie });
    assert.equal(after.status, 200);
    assert.ok(new Date(after.json.subscription.currentPeriodEnd).getTime() > Date.now());
    assert.equal(after.json.usage.leadsUsed, 0);
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: `${RUN_TAG} new-cycle` },
        cookie: owner.cookie,
      })).status,
      201
    );
    // Old-period leads still exist — only the window moved.
    const list = await api("GET", `/api/businesses/${biz.id}/leads?pageSize=100`, { cookie: owner.cookie });
    assert.equal(list.json.total, 51);
  });
});

describe("workspace limits and AGENCY", () => {
  it("blocks a second FREE workspace but allows unlimited on AGENCY", async () => {
    const owner = await registerAndLogin();
    const first = await createBusiness(owner.cookie, `${RUN_TAG} ws-one`);
    const second = await api("POST", "/api/businesses", {
      body: { name: `${RUN_TAG} ws-two` },
      cookie: owner.cookie,
    });
    assert.equal(second.status, 402, `expected 402, got ${second.status}: ${JSON.stringify(second.json)}`);

    await setPlan(owner.cookie, first.id, "AGENCY");
    const retry = await api("POST", "/api/businesses", {
      body: { name: `${RUN_TAG} ws-two` },
      cookie: owner.cookie,
    });
    assert.equal(retry.status, 201, `agency second workspace failed: ${JSON.stringify(retry.json)}`);
    const third = await api("POST", "/api/businesses", {
      body: { name: `${RUN_TAG} ws-three` },
      cookie: owner.cookie,
    });
    assert.equal(third.status, 201, `agency third workspace failed: ${JSON.stringify(third.json)}`);
  });
});

describe("billing settings UI", () => {
  it("renders plan, usage, renewal, and plan picker gated by role", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} billing-ui`);
    await setPlan(owner.cookie, biz.id, "STARTER");
    await api("POST", `/api/businesses/${biz.id}/members`, {
      body: { email: sales.email, role: "SALES" },
      cookie: owner.cookie,
    });

    const page = await getHtml(`/dashboard/settings/billing?businessId=${biz.id}`, owner.cookie);
    assert.equal(page.status, 200, `billing page failed with ${page.status}`);
    for (const needle of [
      "Billing",
      "Current plan",
      "Starter",
      "Leads this month",
      "Team members",
      "Renews",
      "Free",
      "Growth",
      "Business",
      "Agency",
    ]) {
      assert.ok(page.html.includes(needle), `billing page missing ${JSON.stringify(needle)}`);
    }
    const salesPage = await getHtml(`/dashboard/settings/billing?businessId=${biz.id}`, sales.cookie);
    assert.equal(salesPage.status, 200);
    assert.ok(salesPage.html.includes("Only the workspace owner can change"), "role gate copy missing");
  });
});
