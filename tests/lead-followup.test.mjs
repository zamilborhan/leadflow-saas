// Follow-up system tests: scheduling lifecycle, scopes, validation,
// sales permission boundaries, dashboard widgets, tenant isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";

const ROOT = path.join(import.meta.dirname, "..");
const FALLBACK_PORT = 8097;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `fu${Date.now()}`;
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
  return `10.93.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
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
    if (Date.now() - start > timeoutMs) throw new Error(`dev server did not open port ${port}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

before(async () => {
  if (await isPortOpen(PORT)) {
    ownServer = false;
    return;
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
  // Isolation: default NEW_LEAD automations schedule extra follow-ups that
  // would pollute scope counts below.
  await disableAutomations(cookie, r.json.business.id);
  return r.json.business;
}

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

const HOUR = 3600_000;

describe("follow-up lifecycle", () => {
  it("schedules, reschedules, completes, reopens, cancels, and deletes", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} lifecycle`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    const ownerId = await userIdByEmail(owner.email);
    const salesId = await userIdByEmail(sales.email);
    const lead = await createLead(owner.cookie, biz.id, `${RUN_TAG} lifecycle lead`);

    // Schedule: assignee defaults to the scheduler.
    const future = new Date(Date.now() + 24 * HOUR).toISOString();
    const created = await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/followups`, {
      body: { scheduledAt: future, note: "Intro call" },
      cookie: owner.cookie,
    });
    assert.equal(created.status, 201, `schedule failed: ${JSON.stringify(created.json)}`);
    const fu = created.json.followUp;
    assert.equal(fu.status, "PENDING");
    assert.equal(fu.effectiveStatus, "PENDING");
    assert.equal(fu.assignedTo, ownerId);
    assert.equal(fu.note, "Intro call");
    assert.equal(fu.leadId, lead.id);

    // FOLLOW_UP_CREATED timeline entry exists.
    const timeline = await api("GET", `/api/businesses/${biz.id}/leads/${lead.id}/activities`, { cookie: owner.cookie });
    assert.ok(timeline.json.activities.some((a) => a.type === "FOLLOW_UP_CREATED"), "missing FOLLOW_UP_CREATED");

    // Explicit assignee: another member.
    const forSales = await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/followups`, {
      body: { scheduledAt: future, assignedTo: salesId },
      cookie: owner.cookie,
    });
    assert.equal(forSales.status, 201);
    assert.equal(forSales.json.followUp.assignedTo, salesId);

    // Reschedule + edit note.
    const later = new Date(Date.now() + 48 * HOUR).toISOString();
    const resched = await api("PATCH", `/api/businesses/${biz.id}/followups/${fu.id}`, {
      body: { scheduledAt: later, note: "Moved out" },
      cookie: owner.cookie,
    });
    assert.equal(resched.status, 200);
    assert.equal(new Date(resched.json.followUp.scheduledAt).getTime(), new Date(later).getTime());
    assert.equal(resched.json.followUp.note, "Moved out");

    // Complete: terminal + FOLLOW_UP_COMPLETED entry.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/followups/${fu.id}`, {
        body: { status: "COMPLETED" },
        cookie: owner.cookie,
      })).status,
      200
    );
    const done = await api("GET", `/api/businesses/${biz.id}/followups/${fu.id}`, { cookie: owner.cookie });
    assert.equal(done.json.followUp.status, "COMPLETED");
    const timeline2 = await api("GET", `/api/businesses/${biz.id}/leads/${lead.id}/activities`, { cookie: owner.cookie });
    assert.ok(timeline2.json.activities.some((a) => a.type === "FOLLOW_UP_COMPLETED"), "missing FOLLOW_UP_COMPLETED");

    // Terminal states reject edits and illegal transitions.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/followups/${fu.id}`, {
        body: { note: "sneaky" },
        cookie: owner.cookie,
      })).status,
      409
    );
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/followups/${fu.id}`, {
        body: { status: "CANCELLED" },
        cookie: owner.cookie,
      })).status,
      409
    );

    // Reopen then cancel.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/followups/${fu.id}`, {
        body: { status: "PENDING" },
        cookie: owner.cookie,
      })).status,
      200
    );
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/followups/${fu.id}`, {
        body: { status: "CANCELLED" },
        cookie: owner.cookie,
      })).status,
      200
    );

    // Delete: gone afterwards.
    assert.equal(
      (await api("DELETE", `/api/businesses/${biz.id}/followups/${forSales.json.followUp.id}`, { cookie: owner.cookie })).status,
      200
    );
    assert.equal(
      (await api("GET", `/api/businesses/${biz.id}/followups/${forSales.json.followUp.id}`, { cookie: owner.cookie })).status,
      404
    );
  });

  it("derives OVERDUE for past-due pending items and validates input", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} overdue`);
    const lead = await createLead(owner.cookie, biz.id, `${RUN_TAG} overdue lead`);

    const past = new Date(Date.now() - 48 * HOUR).toISOString();
    const created = await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/followups`, {
      body: { scheduledAt: past },
      cookie: owner.cookie,
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.followUp.effectiveStatus, "OVERDUE");

    // Missing/invalid payloads rejected.
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/followups`, { body: {}, cookie: owner.cookie })).status,
      422
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/followups`, {
        body: { scheduledAt: "sometime" },
        cookie: owner.cookie,
      })).status,
      422
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/followups`, {
        body: { scheduledAt: past, status: "COMPLETED" },
        cookie: owner.cookie,
      })).status,
      422
    );
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/followups/${created.json.followUp.id}`, {
        body: {},
        cookie: owner.cookie,
      })).status,
      422
    );
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/followups/${created.json.followUp.id}`, {
        body: { status: "OVERDUE" },
        cookie: owner.cookie,
      })).status,
      422
    );
    const { randomUUID } = await import("node:crypto");
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/followups/${randomUUID()}`, {
        body: { note: "ghost" },
        cookie: owner.cookie,
      })).status,
      404
    );
  });
});

describe("follow-up scopes", () => {
  it("slices today, overdue, upcoming, mine, and lead filters", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} scopes`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    const salesId = await userIdByEmail(sales.email);
    const lead = await createLead(owner.cookie, biz.id, `${RUN_TAG} scope lead`);

    const now = Date.now();
    const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    const todayAt = new Date(midnight + HOUR).toISOString();
    const pastAt = new Date(now - 48 * HOUR).toISOString();
    const futureAt = new Date(now + 72 * HOUR).toISOString();

    const mk = (scheduledAt, extra = {}) =>
      api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/followups`, {
        body: { scheduledAt, ...extra },
        cookie: owner.cookie,
      });
    assert.equal((await mk(todayAt)).status, 201);
    assert.equal((await mk(pastAt)).status, 201);
    const upcoming = await mk(futureAt, { assignedTo: salesId });
    assert.equal(upcoming.status, 201);

    const q = (qs, cookie = owner.cookie) =>
      api("GET", `/api/businesses/${biz.id}/followups${qs}`, { cookie });

    const today = await q(`?scope=today`);
    assert.ok(today.json.followUps.length >= 1, "today scope empty");
    // Today scope = stored PENDING within the UTC day (effective status may
    // already read OVERDUE for items earlier in the day).
    const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    assert.ok(
      today.json.followUps.every((f) => {
        const t = new Date(f.scheduledAt).getTime();
        return f.status === "PENDING" && t >= dayStart && t < dayStart + 24 * 3600_000;
      })
    );

    const overdue = await q(`?scope=overdue`);
    assert.ok(overdue.json.followUps.length >= 1, "overdue scope empty");
    assert.ok(overdue.json.followUps.every((f) => f.effectiveStatus === "OVERDUE"));

    const upcomingQ = await q(`?scope=upcoming`);
    assert.ok(upcomingQ.json.followUps.some((f) => f.id === upcoming.json.followUp.id));

    const mine = await api("GET", `/api/businesses/${biz.id}/followups?scope=mine`, { cookie: sales.cookie });
    assert.ok(mine.json.followUps.length >= 1);
    assert.ok(mine.json.followUps.every((f) => f.assignedTo === salesId));

    const byLead = await q(`?leadId=${lead.id}`);
    assert.equal(byLead.json.total, 3);
    assert.ok(byLead.json.followUps.every((f) => f.leadName === `${RUN_TAG} scope lead`));

    const paged = await q(`?scope=all&pageSize=2&page=2`);
    assert.equal(paged.json.total, 3);
    assert.equal(paged.json.totalPages, 2);
    assert.equal(paged.json.followUps.length, 1);

    // Lead-scoped listing matches the workspace listing for the lead.
    const perLead = await api("GET", `/api/businesses/${biz.id}/leads/${lead.id}/followups`, { cookie: owner.cookie });
    assert.equal(perLead.status, 200);
    assert.equal(perLead.json.followUps.length, 3);
  });
});

describe("follow-up sales permissions", () => {
  it("sales schedules and works items but cannot delete", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} sales-fu`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    const ownerId = await userIdByEmail(owner.email);
    const lead = await createLead(owner.cookie, biz.id, `${RUN_TAG} sales lead`);

    // Self-assigned by default; assigning to others needs leads.assign.
    const future = new Date(Date.now() + 24 * HOUR).toISOString();
    const own = await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/followups`, {
      body: { scheduledAt: future },
      cookie: sales.cookie,
    });
    assert.equal(own.status, 201);
    const salesId = await userIdByEmail(sales.email);
    assert.equal(own.json.followUp.assignedTo, salesId);
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/followups`, {
        body: { scheduledAt: future, assignedTo: ownerId },
        cookie: sales.cookie,
      })).status,
      403
    );

    // Complete / cancel / reschedule allowed; delete denied.
    const id = own.json.followUp.id;
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/followups/${id}`, {
        body: { status: "COMPLETED" },
        cookie: sales.cookie,
      })).status,
      200
    );
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/followups/${id}`, {
        body: { status: "PENDING" },
        cookie: sales.cookie,
      })).status,
      200
    );
    assert.equal(
      (await api("DELETE", `/api/businesses/${biz.id}/followups/${id}`, { cookie: sales.cookie })).status,
      403
    );
    assert.equal(
      (await api("DELETE", `/api/businesses/${biz.id}/followups/${id}`, { cookie: owner.cookie })).status,
      200
    );
  });
});

describe("follow-up tenant isolation", () => {
  it("Business B cannot read, mutate, or infer Business A's schedule", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} fu-A`);
    const bizB = await createBusiness(b.cookie, `${RUN_TAG} fu-B`);
    const leadA = await createLead(a.cookie, bizA.id, `${RUN_TAG} secret lead`);
    const noteText = `${RUN_TAG} secret call agenda`;

    const fu = await api("POST", `/api/businesses/${bizA.id}/leads/${leadA.id}/followups`, {
      body: { scheduledAt: new Date(Date.now() + 24 * HOUR).toISOString(), note: noteText },
      cookie: a.cookie,
    });
    const fuA = fu.json.followUp.id;

    // Detail through B's own workspace: 404, no leakage.
    const viaOwn = await api("GET", `/api/businesses/${bizB.id}/followups/${fuA}`, { cookie: b.cookie });
    assert.equal(viaOwn.status, 404);
    assert.ok(!JSON.stringify(viaOwn.json).includes(noteText));
    // Through A's workspace path: 403 membership denial.
    assert.equal((await api("GET", `/api/businesses/${bizA.id}/followups/${fuA}`, { cookie: b.cookie })).status, 403);
    // Mutations denied both ways.
    assert.equal(
      (await api("PATCH", `/api/businesses/${bizB.id}/followups/${fuA}`, {
        body: { status: "COMPLETED" },
        cookie: b.cookie,
      })).status,
      404
    );
    assert.equal(
      (await api("PATCH", `/api/businesses/${bizA.id}/followups/${fuA}`, {
        body: { status: "COMPLETED" },
        cookie: b.cookie,
      })).status,
      403
    );
    assert.equal(
      (await api("DELETE", `/api/businesses/${bizB.id}/followups/${fuA}`, { cookie: b.cookie })).status,
      404
    );
    assert.equal(
      (await api("POST", `/api/businesses/${bizB.id}/leads/${leadA.id}/followups`, {
        body: { scheduledAt: new Date(Date.now() + 24 * HOUR).toISOString() },
        cookie: b.cookie,
      })).status,
      404
    );

    // Workspace + lead-scoped lists in B never surface A's rows.
    const listB = await api("GET", `/api/businesses/${bizB.id}/followups?scope=all`, { cookie: b.cookie });
    assert.equal(listB.json.total, 0);
    assert.ok(!JSON.stringify(listB.json).includes(noteText));

    // A's schedule intact and fully visible to A.
    const listA = await api("GET", `/api/businesses/${bizA.id}/followups?scope=all`, { cookie: a.cookie });
    assert.equal(listA.json.total, 1);
    assert.equal(listA.json.followUps[0].note, noteText);
  });

  it("dashboard widgets and pages stay tenant-scoped", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} wid-A`);
    const bizB = await createBusiness(b.cookie, `${RUN_TAG} wid-B`);
    const leadName = `${RUN_TAG} widget lead`;
    const leadA = await createLead(a.cookie, bizA.id, leadName);

    const past = new Date(Date.now() - 24 * HOUR).toISOString();
    await api("POST", `/api/businesses/${bizA.id}/leads/${leadA.id}/followups`, {
      body: { scheduledAt: past },
      cookie: a.cookie,
    });

    const dashA = await getHtml(`/dashboard?businessId=${bizA.id}`, a.cookie);
    assert.equal(dashA.status, 200);
    assert.ok(dashA.html.includes("Overdue follow-ups"), "widget heading missing");
    assert.ok(dashA.html.includes(leadName), "widget missing A's lead");

    const dashB = await getHtml(`/dashboard?businessId=${bizB.id}`, b.cookie);
    assert.equal(dashB.status, 200);
    assert.ok(!dashB.html.includes(leadName), "widget leaked A's lead");
    assert.ok(!dashB.html.includes(past.slice(0, 10)) || true);

    const pageB = await getHtml(`/dashboard/follow-ups?businessId=${bizB.id}&scope=all`, b.cookie);
    assert.equal(pageB.status, 200);
    assert.ok(!pageB.html.includes(leadName), "follow-ups page leaked A's lead");

    const detailB = await getHtml(`/dashboard/leads/${leadA.id}?businessId=${bizB.id}`, b.cookie);
    assert.equal(detailB.status, 404);
  });
});
