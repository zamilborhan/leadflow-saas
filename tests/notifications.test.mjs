// In-app notification tests: pure catalog/validation/audience rules plus
// HTTP end-to-end over a spawned server (mirrors lead-activity.test.mjs):
// fan-out on assignment, derived follow-up alerts via sync, read/read-all,
// badge counts, tenant isolation, and role-aware delivery.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";
import {
  NOTIFICATION_AUDIENCE,
  NOTIFICATION_TYPES,
  isValidNotificationType,
  validateNotificationQuery,
} from "../src/lib/tenancy/notification-catalog.ts";

describe("notification type catalog (pure)", () => {
  it("supports exactly the six required types", () => {
    assert.deepEqual([...NOTIFICATION_TYPES], [
      "LEAD_ASSIGNED",
      "FOLLOWUP_DUE",
      "FOLLOWUP_OVERDUE",
      "WHATSAPP_FAILED",
      "FACEBOOK_EXPIRED",
      "PAYMENT_FAILED",
    ]);
    for (const t of NOTIFICATION_TYPES) assert.equal(isValidNotificationType(t), true);
    assert.equal(isValidNotificationType("LEAD_CREATED"), false);
    assert.equal(isValidNotificationType(""), false);
    assert.equal(isValidNotificationType(null), false);
    assert.equal(isValidNotificationType(undefined), false);
  });

  it("maps role-aware audiences per type", () => {
    // Assignments go only to the assignee; connection/billing failures
    // only to managers; follow-ups and WhatsApp failures prefer the
    // assignee and fall back to managers.
    assert.equal(NOTIFICATION_AUDIENCE.LEAD_ASSIGNED, "assignee");
    assert.equal(NOTIFICATION_AUDIENCE.FOLLOWUP_DUE, "assignee-or-managers");
    assert.equal(NOTIFICATION_AUDIENCE.FOLLOWUP_OVERDUE, "assignee-or-managers");
    assert.equal(NOTIFICATION_AUDIENCE.WHATSAPP_FAILED, "assignee-or-managers");
    assert.equal(NOTIFICATION_AUDIENCE.FACEBOOK_EXPIRED, "managers");
    assert.equal(NOTIFICATION_AUDIENCE.PAYMENT_FAILED, "managers");
  });
});

describe("notification list query validation (pure)", () => {
  it("defaults to all, capped at 50", () => {
    assert.deepEqual(validateNotificationQuery({}), { unreadOnly: false, limit: 50 });
    assert.deepEqual(validateNotificationQuery({ unreadOnly: "1", limit: "10" }), {
      unreadOnly: true,
      limit: 10,
    });
  });

  it("parses truthy flags and clamps limits", () => {
    for (const v of ["1", "true", "TRUE", "yes"]) {
      assert.equal(validateNotificationQuery({ unreadOnly: v }).unreadOnly, true, v);
    }
    for (const v of ["0", "false", "no", "", "maybe"]) {
      assert.equal(validateNotificationQuery({ unreadOnly: v }).unreadOnly, false, v);
    }
    assert.equal(validateNotificationQuery({ limit: "0" }).limit, 50);
    assert.equal(validateNotificationQuery({ limit: "-3" }).limit, 50);
    assert.equal(validateNotificationQuery({ limit: "9999" }).limit, 100);
    assert.equal(validateNotificationQuery({ limit: "abc" }).limit, 50);
    assert.equal(validateNotificationQuery({ limit: ["5", "10"] }).limit, 5);
  });
});

// ---------------------------------------------------------------------------
// HTTP end-to-end: spawned dev server (own port, parallel-safe) + pg cleanup.
// ---------------------------------------------------------------------------

const ROOT = path.join(import.meta.dirname, "..");
// Preferred shared servers first (repo convention is :4000; this
// environment runs the project dev server on :3000), else spawn our own.
// Note: `next dev` holds a single-server lock per directory, so a second
// spawn only works when no server is already running.
const CANDIDATE_PORTS = [4000, 3000];
const FALLBACK_PORT = 8094;
let PORT = CANDIDATE_PORTS[0];
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `ntf${Date.now()}`;
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
  return `10.95.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
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
  // The spawned dev server resets connections while (re)compiling — retry.
  let lastErr = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: payload, redirect: "manual" });
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, headers: res.headers, json, cookie: sessionCookieFrom(res) };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

async function getHtml(urlPath, cookie) {
  const res = await fetch(`${BASE}${urlPath}`, {
    headers: { ...(cookie ? { cookie } : {}), "x-forwarded-for": nextIp() },
    redirect: "manual",
  });
  return { status: res.status, html: await res.text() };
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
    if (Date.now() - start > timeoutMs) throw new Error(`port ${port} did not open`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function waitForHttp(timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/me`, { redirect: "manual" });
      await res.text().catch(() => null);
      if (res.status === 401) return;
    } catch {
      // Still compiling — keep waiting.
    }
    if (Date.now() - start > timeoutMs) throw new Error("server did not answer HTTP");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function spawnServer(port) {
  const env = { ...process.env, ...loadDotEnv(), PORT: String(port) };
  const child = spawn("node", ["node_modules/next/dist/bin/next", "dev", "--port", String(port)], {
    cwd: ROOT,
    env,
    stdio: "ignore",
  });
  ownServer = true;
  server = child;
}

before(async () => {
  // Prefer a shared dev server that actually answers HTTP; otherwise
  // spawn our own on the fallback port (a stale listener may accept TCP
  // without ever serving).
  for (const port of CANDIDATE_PORTS) {
    PORT = port;
    BASE = `http://127.0.0.1:${PORT}`;
    if (await isPortOpen(PORT)) {
      try {
        await waitForHttp(30_000);
        return;
      } catch {
        // Not serving — try the next candidate.
      }
    }
  }
  PORT = FALLBACK_PORT;
  BASE = `http://127.0.0.1:${PORT}`;
  spawnServer(PORT);
  await waitForPort(PORT, 180_000);
  await waitForHttp(240_000);
}, { timeout: 500_000 });

after(async () => {
  if (server && ownServer) {
    server.kill("SIGTERM");
    server = null;
  }
  const client = pg();
  await client.connect();
  try {
    await client.query(`DELETE FROM "Notification" WHERE "businessId" IN (SELECT id FROM "Business" WHERE name LIKE '${RUN_TAG}%')`);
    await client.query(`DELETE FROM "LeadActivity" WHERE "businessId" IN (SELECT id FROM "Business" WHERE name LIKE '${RUN_TAG}%')`);
    await client.query(`DELETE FROM "FollowUp" WHERE "businessId" IN (SELECT id FROM "Business" WHERE name LIKE '${RUN_TAG}%')`);
    await client.query(`DELETE FROM "Lead" WHERE "businessId" IN (SELECT id FROM "Business" WHERE name LIKE '${RUN_TAG}%')`);
    await client.query(`DELETE FROM "BusinessMember" WHERE "businessId" IN (SELECT id FROM "Business" WHERE name LIKE '${RUN_TAG}%')`);
    await client.query(`DELETE FROM "Business" WHERE name LIKE '${RUN_TAG}%'`);
    await client.query(`DELETE FROM "Session" WHERE "userId" IN (SELECT id FROM "User" WHERE email LIKE '${RUN_TAG}%')`);
    await client.query(`DELETE FROM "User" WHERE email LIKE '${RUN_TAG}%'`);
  } finally {
    await client.end();
  }
}, { timeout: 60_000 });

async function registerAndLogin() {
  const email = testEmail();
  const reg = await api("POST", "/api/auth/register", { body: { email, password: PASSWORD } });
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.json)}`);
  const login = await api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
  assert.equal(login.status, 200, `login failed: ${JSON.stringify(login.json)}`);
  return { email, cookie: login.cookie };
}

async function createBusiness(cookie, name, plan = "STARTER") {
  const res = await api("POST", "/api/businesses", { body: { name }, cookie });
  assert.equal(res.status, 201, `create business failed: ${JSON.stringify(res.json)}`);
  // Quota context: these tests invite a second member, which exceeds FREE.
  if (plan) {
    const s = await api("PATCH", `/api/businesses/${res.json.business.id}/subscription`, {
      body: { planCode: plan },
      cookie,
    });
    assert.equal(s.status, 200, `set plan failed: ${JSON.stringify(s.json)}`);
  }
  return res.json.business;
}

describe("notification fan-out on assignment (HTTP)", () => {
  it("notifies only the assignee when a lead is assigned", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} assign`);
    const invite = await api("POST", `/api/businesses/${biz.id}/members`, {
      body: { email: sales.email, role: "SALES" },
      cookie: owner.cookie,
    });
    assert.equal(invite.status, 201, `invite failed: ${JSON.stringify(invite.json)}`);
    const salesMember = invite.json.member ?? invite.json.membership ?? null;

    const created = await api("POST", `/api/businesses/${biz.id}/leads`, {
      body: { name: `${RUN_TAG} prospect`, phone: "+880170000001" },
      cookie: owner.cookie,
    });
    assert.equal(created.status, 201, `create lead failed: ${JSON.stringify(created.json)}`);
    const leadId = created.json.lead.id;

    const assigneeId = salesMember?.userId ?? salesMember?.user?.id;
    assert.ok(assigneeId, `invite response missing user id: ${JSON.stringify(invite.json)}`);
    const patched = await api("PATCH", `/api/businesses/${biz.id}/leads/${leadId}`, {
      body: { assignedTo: assigneeId },
      cookie: owner.cookie,
    });
    assert.equal(patched.status, 200, `assign failed: ${JSON.stringify(patched.json)}`);

    // Assignee sees exactly one LEAD_ASSIGNED notification.
    const salesList = await api("GET", `/api/businesses/${biz.id}/notifications`, { cookie: sales.cookie });
    assert.equal(salesList.status, 200, `sales list failed: ${JSON.stringify(salesList.json)}`);
    assert.equal(salesList.json.notifications.length, 1);
    assert.equal(salesList.json.notifications[0].type, "LEAD_ASSIGNED");
    assert.equal(salesList.json.notifications[0].leadId, leadId);
    assert.equal(salesList.json.notifications[0].readAt, null);

    const salesCount = await api("GET", `/api/businesses/${biz.id}/notifications/unread-count`, {
      cookie: sales.cookie,
    });
    assert.equal(salesCount.status, 200);
    assert.equal(salesCount.json.unread, 1);

    // Owner (the assigner) gets nothing — no self-noise, no leakage.
    const ownerList = await api("GET", `/api/businesses/${biz.id}/notifications`, { cookie: owner.cookie });
    assert.equal(ownerList.status, 200);
    assert.equal(ownerList.json.notifications.length, 0);
    const ownerCount = await api("GET", `/api/businesses/${biz.id}/notifications/unread-count`, {
      cookie: owner.cookie,
    });
    assert.equal(ownerCount.json.unread, 0);
  });

  it("skips notification on self-assignment and unassignment", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} selfassign`);
    const created = await api("POST", `/api/businesses/${biz.id}/leads`, {
      body: { name: `${RUN_TAG} solo` },
      cookie: owner.cookie,
    });
    assert.equal(created.status, 201);
    const me = await api("GET", "/api/me", { cookie: owner.cookie });
    const myId = me.json?.user?.id ?? me.json?.id;
    assert.ok(myId, `me response missing id: ${JSON.stringify(me.json)}`);
    const selfAssign = await api("PATCH", `/api/businesses/${biz.id}/leads/${created.json.lead.id}`, {
      body: { assignedTo: myId },
      cookie: owner.cookie,
    });
    assert.equal(selfAssign.status, 200, `self-assign failed: ${JSON.stringify(selfAssign.json)}`);
    const unassign = await api("PATCH", `/api/businesses/${biz.id}/leads/${created.json.lead.id}`, {
      body: { assignedTo: null },
      cookie: owner.cookie,
    });
    assert.equal(unassign.status, 200, `unassign failed: ${JSON.stringify(unassign.json)}`);
    const list = await api("GET", `/api/businesses/${biz.id}/notifications`, { cookie: owner.cookie });
    assert.equal(list.status, 200);
    assert.equal(list.json.notifications.length, 0);
  });
});

describe("notification read flows (HTTP)", () => {
  it("marks one as read and marks all as read, scoping strictly to self", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} reads`);
    const invite = await api("POST", `/api/businesses/${biz.id}/members`, {
      body: { email: sales.email, role: "SALES" },
      cookie: owner.cookie,
    });
    assert.equal(invite.status, 201);
    const assigneeId = (invite.json.member ?? invite.json.membership ?? {}).userId;
    for (let i = 0; i < 3; i++) {
      const created = await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: `${RUN_TAG} r${i}`, assignedTo: assigneeId },
        cookie: owner.cookie,
      });
      assert.equal(created.status, 201, `create ${i} failed: ${JSON.stringify(created.json)}`);
    }

    let list = await api("GET", `/api/businesses/${biz.id}/notifications`, { cookie: sales.cookie });
    assert.equal(list.json.notifications.length, 3);
    const firstId = list.json.notifications[0].id;

    // unreadOnly filter.
    const unreadOnly = await api("GET", `/api/businesses/${biz.id}/notifications?unreadOnly=1`, {
      cookie: sales.cookie,
    });
    assert.equal(unreadOnly.json.notifications.length, 3);

    const read = await api("POST", `/api/businesses/${biz.id}/notifications/${firstId}/read`, {
      cookie: sales.cookie,
    });
    assert.equal(read.status, 200);
    assert.ok(read.json.notification.readAt, "readAt must be set");

    const afterOne = await api("GET", `/api/businesses/${biz.id}/notifications?unreadOnly=1`, {
      cookie: sales.cookie,
    });
    assert.equal(afterOne.json.notifications.length, 2);
    const count = await api("GET", `/api/businesses/${biz.id}/notifications/unread-count`, {
      cookie: sales.cookie,
    });
    assert.equal(count.json.unread, 2);

    // Another user's row id is invisible to me (404, no oracle).
    const ownerRead = await api("POST", `/api/businesses/${biz.id}/notifications/${firstId}/read`, {
      cookie: owner.cookie,
    });
    assert.equal(ownerRead.status, 404);

    // Unknown id → 404.
    const missing = await api(
      "POST",
      `/api/businesses/${biz.id}/notifications/00000000-0000-0000-0000-000000000000/read`,
      { cookie: sales.cookie }
    );
    assert.equal(missing.status, 404);

    const all = await api("POST", `/api/businesses/${biz.id}/notifications/read-all`, { cookie: sales.cookie });
    assert.equal(all.status, 200);
    assert.equal(all.json.marked, 2);
    const empty = await api("GET", `/api/businesses/${biz.id}/notifications/unread-count`, {
      cookie: sales.cookie,
    });
    assert.equal(empty.json.unread, 0);
    const repeat = await api("POST", `/api/businesses/${biz.id}/notifications/read-all`, {
      cookie: sales.cookie,
    });
    assert.equal(repeat.json.marked, 0);
  });

  it("rejects unauthenticated and cross-tenant access", async () => {
    const owner = await registerAndLogin();
    const outsider = await registerAndLogin();
    const bizA = await createBusiness(owner.cookie, `${RUN_TAG} tenantA`);
    await createBusiness(outsider.cookie, `${RUN_TAG} tenantB`);

    const anon = await api("GET", `/api/businesses/${bizA.id}/notifications`);
    assert.equal(anon.status, 401);
    const anonCount = await api("GET", `/api/businesses/${bizA.id}/notifications/unread-count`);
    assert.equal(anonCount.status, 401);

    const cross = await api("GET", `/api/businesses/${bizA.id}/notifications`, { cookie: outsider.cookie });
    assert.equal(cross.status, 403);
    const crossRead = await api(
      "POST",
      `/api/businesses/${bizA.id}/notifications/00000000-0000-0000-0000-000000000000/read`,
      { cookie: outsider.cookie }
    );
    assert.equal(crossRead.status, 403);
  });
});

describe("derived notification sync (HTTP)", () => {
  // Creating a lead fires the workspace automation engine, which schedules
  // its own +24h follow-up. Clear those first so each sync test observes
  // only the follow-ups it created.
  async function clearLeadFollowUps(cookie, bizId, leadId) {
    const list = await api("GET", `/api/businesses/${bizId}/leads/${leadId}/followups`, { cookie });
    assert.equal(list.status, 200, `list follow-ups failed: ${JSON.stringify(list.json)}`);
    for (const fu of list.json.followUps) {
      const del = await api("DELETE", `/api/businesses/${bizId}/followups/${fu.id}`, { cookie });
      assert.equal(del.status, 200, `delete follow-up failed: ${JSON.stringify(del.json)}`);
    }
  }

  it("generates FOLLOWUP_OVERDUE once, then dedupes", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} overdue`);
    const created = await api("POST", `/api/businesses/${biz.id}/leads`, {
      body: { name: `${RUN_TAG} late` },
      cookie: owner.cookie,
    });
    assert.equal(created.status, 201);
    await clearLeadFollowUps(owner.cookie, biz.id, created.json.lead.id);
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fu = await api("POST", `/api/businesses/${biz.id}/leads/${created.json.lead.id}/followups`, {
      body: { scheduledAt: past, note: "call back" },
      cookie: owner.cookie,
    });
    assert.equal(fu.status, 201, `follow-up failed: ${JSON.stringify(fu.json)}`);

    const sync = await api("POST", `/api/businesses/${biz.id}/notifications/sync`, { cookie: owner.cookie });
    assert.equal(sync.status, 200, `sync failed: ${JSON.stringify(sync.json)}`);
    assert.equal(sync.json.followUps.created, 1);

    const list = await api("GET", `/api/businesses/${biz.id}/notifications`, { cookie: owner.cookie });
    assert.equal(list.status, 200);
    const overdue = list.json.notifications.filter((n) => n.type === "FOLLOWUP_OVERDUE");
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].leadId, created.json.lead.id);

    const again = await api("POST", `/api/businesses/${biz.id}/notifications/sync`, { cookie: owner.cookie });
    assert.equal(again.json.followUps.created, 0, "second sync must dedupe");
    const relist = await api("GET", `/api/businesses/${biz.id}/notifications`, { cookie: owner.cookie });
    assert.equal(
      relist.json.notifications.filter((n) => n.type === "FOLLOWUP_OVERDUE").length,
      1
    );
  });

  it("generates FOLLOWUP_DUE for items within 24h and skips the rest", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} due`);
    const created = await api("POST", `/api/businesses/${biz.id}/leads`, {
      body: { name: `${RUN_TAG} soon` },
      cookie: owner.cookie,
    });
    assert.equal(created.status, 201);
    await clearLeadFollowUps(owner.cookie, biz.id, created.json.lead.id);
    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const far = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    for (const when of [soon, far]) {
      const fu = await api("POST", `/api/businesses/${biz.id}/leads/${created.json.lead.id}/followups`, {
        body: { scheduledAt: when },
        cookie: owner.cookie,
      });
      assert.equal(fu.status, 201);
    }
    const sync = await api("POST", `/api/businesses/${biz.id}/notifications/sync`, { cookie: owner.cookie });
    assert.equal(sync.status, 200);
    const list = await api("GET", `/api/businesses/${biz.id}/notifications`, { cookie: owner.cookie });
    assert.equal(
      list.json.notifications.filter((n) => n.type === "FOLLOWUP_DUE").length,
      1,
      `expected 1 due item: ${JSON.stringify(list.json.notifications)}`
    );
  });

  it("notifies managers on payment failure, idempotent per reference", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} pay`);
    const invite = await api("POST", `/api/businesses/${biz.id}/members`, {
      body: { email: sales.email, role: "SALES" },
      cookie: owner.cookie,
    });
    assert.equal(invite.status, 201);

    const denied = await api("POST", `/api/businesses/${biz.id}/notifications/payment-failed`, {
      body: { reference: "inv-1" },
      cookie: sales.cookie,
    });
    assert.equal(denied.status, 403, "SALES must not raise billing alerts");

    const bad = await api("POST", `/api/businesses/${biz.id}/notifications/payment-failed`, {
      body: {},
      cookie: owner.cookie,
    });
    assert.equal(bad.status, 422);

    const first = await api("POST", `/api/businesses/${biz.id}/notifications/payment-failed`, {
      body: { reference: "inv-1", amount: "৳5,000", detail: "Card declined." },
      cookie: owner.cookie,
    });
    assert.equal(first.status, 201, `payment-failed failed: ${JSON.stringify(first.json)}`);
    assert.equal(first.json.notifications.length, 1);
    assert.equal(first.json.notifications[0].type, "PAYMENT_FAILED");

    const dup = await api("POST", `/api/businesses/${biz.id}/notifications/payment-failed`, {
      body: { reference: "inv-1" },
      cookie: owner.cookie,
    });
    assert.equal(dup.status, 201);
    assert.equal(dup.json.notifications.length, 0, "same reference must dedupe");

    // Managers see it; SALES never does.
    const ownerList = await api("GET", `/api/businesses/${biz.id}/notifications`, { cookie: owner.cookie });
    assert.ok(ownerList.json.notifications.some((n) => n.type === "PAYMENT_FAILED"));
    const salesList = await api("GET", `/api/businesses/${biz.id}/notifications`, { cookie: sales.cookie });
    assert.ok(!salesList.json.notifications.some((n) => n.type === "PAYMENT_FAILED"));
  });
});

describe("notification center page (HTTP)", () => {
  it("renders the badge, list, and actions for a member", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} page`);
    const page = await getHtml(`/dashboard/notifications?businessId=${biz.id}`, owner.cookie);
    assert.equal(page.status, 200, `page failed with ${page.status}`);
    assert.ok(page.html.includes("Notifications"), "missing page title");
    assert.ok(page.html.includes("Mark all as read"), "missing mark-all action");
    assert.ok(page.html.includes("Refresh"), "missing sync action");
  });
});
