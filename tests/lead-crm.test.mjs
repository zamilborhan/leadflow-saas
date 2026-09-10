// Lead CRM tests: full CRUD, search/filter/sort/pagination, validation,
// sales permission boundaries, and tenant isolation — all over HTTP.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";

const ROOT = path.join(import.meta.dirname, "..");
const FALLBACK_PORT = 8095;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `crm${Date.now()}`;
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
  // Isolation: default NEW_LEAD automations would reassign leads and mutate
  // rows between write and re-read, breaking exact-match assertions below.
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

describe("lead CRUD", () => {
  it("creates, reads, updates, archives, restores, and deletes a fully-loaded lead", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} crud`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    const salesId = await userIdByEmail(sales.email);

    const payload = {
      name: `${RUN_TAG} full lead`,
      email: "prospect@example.com",
      phone: "+8801711111111",
      status: "INTERESTED",
      source: "facebook",
      campaignName: `${RUN_TAG} campaign`,
      adSetName: "AdSet 1",
      adName: "Ad 1",
      facebookLeadId: `fb-${RUN_TAG}`,
      assignedTo: salesId,
      lastContactedAt: "2026-09-01T10:00:00.000Z",
      nextFollowUpAt: "2026-09-10T10:00:00.000Z",
    };
    const created = await api("POST", `/api/businesses/${biz.id}/leads`, { body: payload, cookie: owner.cookie });
    assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.json)}`);
    const lead = created.json.lead;
    assert.equal(lead.businessId, biz.id);
    for (const [k, v] of Object.entries(payload)) {
      if (k === "assignedTo") continue;
      if (k === "lastContactedAt" || k === "nextFollowUpAt") {
        // Timestamptz round-trips in Postgres text format; compare instants.
        assert.equal(new Date(lead[k]).getTime(), new Date(v).getTime(), `field ${k} mismatch`);
        continue;
      }
      assert.equal(lead[k], v, `field ${k} mismatch`);
    }
    assert.equal(lead.assignedTo, salesId);
    assert.equal(lead.archivedAt, null);

    // Read back every field.
    const fetched = await api("GET", `/api/businesses/${biz.id}/leads/${lead.id}`, { cookie: owner.cookie });
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.json.lead, lead);

    // Partial update + explicit null clearing.
    const patched = await api("PATCH", `/api/businesses/${biz.id}/leads/${lead.id}`, {
      body: { status: "FOLLOW_UP", campaignName: "New campaign", phone: null },
      cookie: owner.cookie,
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.lead.status, "FOLLOW_UP");
    assert.equal(patched.json.lead.campaignName, "New campaign");
    assert.equal(patched.json.lead.phone, null);
    assert.equal(patched.json.lead.name, payload.name, "untouched field changed");

    // Archive hides from the default list; archived filter shows it.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/leads/${lead.id}`, {
        body: { archived: true },
        cookie: owner.cookie,
      })).status,
      200
    );
    const activeList = await api("GET", `/api/businesses/${biz.id}/leads`, { cookie: owner.cookie });
    assert.ok(!activeList.json.leads.some((l) => l.id === lead.id), "archived lead in active list");
    const archivedList = await api("GET", `/api/businesses/${biz.id}/leads?archived=archived`, { cookie: owner.cookie });
    assert.ok(archivedList.json.leads.some((l) => l.id === lead.id), "archived lead missing from archived list");
    assert.ok(archivedList.json.leads.find((l) => l.id === lead.id).archivedAt, "archivedAt not set");

    // Restore + hard delete.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/leads/${lead.id}`, {
        body: { archived: false },
        cookie: owner.cookie,
      })).status,
      200
    );
    assert.equal(
      (await api("DELETE", `/api/businesses/${biz.id}/leads/${lead.id}`, { cookie: owner.cookie })).status,
      200
    );
    assert.equal(
      (await api("GET", `/api/businesses/${biz.id}/leads/${lead.id}`, { cookie: owner.cookie })).status,
      404
    );
  });

  it("rejects invalid payloads with 422", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} validation`);

    assert.equal((await api("POST", `/api/businesses/${biz.id}/leads`, { body: {}, cookie: owner.cookie })).status, 422);
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: "x", email: "not-an-email" },
        cookie: owner.cookie,
      })).status,
      422
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: "x", status: "QUALIFIED" },
        cookie: owner.cookie,
      })).status,
      422
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: "x", assignedTo: "not-a-uuid" },
        cookie: owner.cookie,
      })).status,
      422
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: "x", nextFollowUpAt: "next friday-ish" },
        cookie: owner.cookie,
      })).status,
      422
    );
    // Outsider (registered, not a member) cannot be assigned.
    const outsider = await registerAndLogin();
    const outsiderId = await userIdByEmail(outsider.email);
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: "x", assignedTo: outsiderId },
        cookie: owner.cookie,
      })).status,
      403
    );
    // PATCH unknown lead -> 404; archived flag must be boolean.
    const { randomUUID } = await import("node:crypto");
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/members/${randomUUID()}`, {
        body: { role: "SALES" },
        cookie: owner.cookie,
      })).status,
      404
    );
    const lead = (
      await api("POST", `/api/businesses/${biz.id}/leads`, { body: { name: `${RUN_TAG} v` }, cookie: owner.cookie })
    ).json.lead;
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/leads/${lead.id}`, {
        body: { archived: "yes" },
        cookie: owner.cookie,
      })).status,
      422
    );
  });
});

describe("lead search, filter, sort, pagination", () => {
  it("slices the scoped dataset correctly", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} query`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    const salesId = await userIdByEmail(sales.email);

    const seed = [
      { name: `${RUN_TAG} alpha bravo`, status: "NEW", campaignName: `${RUN_TAG} camp-one`, phone: "+880170000001" },
      { name: `${RUN_TAG} alpha charlie`, status: "CONTACTED", campaignName: `${RUN_TAG} camp-two`, phone: "+880170000002" },
      { name: `${RUN_TAG} delta echo`, status: "INTERESTED", campaignName: `${RUN_TAG} camp-one`, phone: "+880170000003" },
      { name: `${RUN_TAG} foxtrot golf`, status: "CONVERTED", campaignName: `${RUN_TAG} camp-two`, phone: "+880170000004" },
      { name: `${RUN_TAG} hotel india`, status: "LOST", campaignName: `${RUN_TAG} camp-one`, phone: "+880170000005" },
    ];
    for (const [i, s] of seed.entries()) {
      const body = { ...s };
      if (i < 2) body.assignedTo = salesId;
      const r = await api("POST", `/api/businesses/${biz.id}/leads`, { body, cookie: owner.cookie });
      assert.equal(r.status, 201, `seed ${i} failed: ${JSON.stringify(r.json)}`);
    }
    const list = (qs) =>
      api("GET", `/api/businesses/${biz.id}/leads${qs}`, { cookie: owner.cookie });

    // Search: name substring, phone digits, campaign text.
    assert.equal((await list(`?search=${RUN_TAG}%20alpha`)).json.total, 2);
    assert.equal((await list(`?search=000003`)).json.total, 1);
    assert.equal((await list(`?search=${RUN_TAG}%20camp-one`)).json.total, 3);
    assert.equal((await list(`?search=${RUN_TAG}%20zzz-nope`)).json.total, 0);

    // Status filter.
    const byStatus = await list(`?status=NEW`);
    assert.equal(byStatus.json.total, 1);
    assert.ok(byStatus.json.leads.every((l) => l.status === "NEW"));

    // Assignee filters.
    assert.equal((await list(`?assignee=me`)).json.total, 0, "owner assigned nothing yet");
    const mine = await api("GET", `/api/businesses/${biz.id}/leads?assignee=me`, { cookie: sales.cookie });
    assert.equal(mine.json.total, 2);
    assert.equal((await list(`?assignee=unassigned`)).json.total, 3);

    // Sort by name ascending: alphabetical across the scoped set.
    const sorted = await list(`?sort=name&dir=asc&pageSize=100`);
    const names = sorted.json.leads.map((l) => l.name);
    assert.deepEqual(names, [...names].sort(), "names not ascending");

    // Pagination: pageSize 2 over 5 rows.
    const p1 = await list(`?pageSize=2&page=1&sort=createdAt&dir=asc`);
    const p2 = await list(`?pageSize=2&page=2&sort=createdAt&dir=asc`);
    const p3 = await list(`?pageSize=2&page=3&sort=createdAt&dir=asc`);
    assert.equal(p1.json.total, 5);
    assert.equal(p1.json.totalPages, 3);
    assert.equal(p1.json.leads.length, 2);
    assert.equal(p2.json.leads.length, 2);
    assert.equal(p3.json.leads.length, 1);
    assert.deepEqual(
      [...p1.json.leads, ...p2.json.leads, ...p3.json.leads].map((l) => l.id).sort(),
      [...p1.json.leads, ...p2.json.leads, ...p3.json.leads].map((l) => l.id).sort()
    );
    const ids = new Set([...p1.json.leads, ...p2.json.leads, ...p3.json.leads].map((l) => l.id));
    assert.equal(ids.size, 5, "pages overlap or miss rows");

    // Archived scope: archive one, counts shift; archived=all reunites.
    const victim = p1.json.leads[0].id;
    await api("PATCH", `/api/businesses/${biz.id}/leads/${victim}`, {
      body: { archived: true },
      cookie: owner.cookie,
    });
    assert.equal((await list(``)).json.total, 4);
    assert.equal((await list(`?archived=all`)).json.total, 5);
    assert.equal((await list(`?archived=archived`)).json.total, 1);
  });
});

describe("lead sales permissions", () => {
  it("sales works leads but cannot assign, archive, or delete", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} sales`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");

    // Create + status change allowed.
    const created = await api("POST", `/api/businesses/${biz.id}/leads`, {
      body: { name: `${RUN_TAG} sales lead` },
      cookie: sales.cookie,
    });
    assert.equal(created.status, 201);
    const id = created.json.lead.id;
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/leads/${id}`, {
        body: { status: "CONTACTED", nextFollowUpAt: "2026-09-12T09:00:00.000Z" },
        cookie: sales.cookie,
      })).status,
      200
    );

    // Assign / archive / delete denied.
    const salesId = await userIdByEmail(sales.email);
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/leads/${id}`, {
        body: { assignedTo: salesId },
        cookie: sales.cookie,
      })).status,
      403
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: "x", assignedTo: salesId },
        cookie: sales.cookie,
      })).status,
      403
    );
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/leads/${id}`, {
        body: { archived: true },
        cookie: sales.cookie,
      })).status,
      403
    );
    assert.equal(
      (await api("DELETE", `/api/businesses/${biz.id}/leads/${id}`, { cookie: sales.cookie })).status,
      403
    );

    // Read paths still work for sales.
    assert.equal((await api("GET", `/api/businesses/${biz.id}/leads/${id}`, { cookie: sales.cookie })).status, 200);
    assert.equal((await api("GET", `/api/businesses/${biz.id}/leads`, { cookie: sales.cookie })).status, 200);

    // Details page renders for sales without delete controls. (Match the
    // button element: the serialized `canDelete` prop also contains "Delete".)
    const page = await getHtml(`/dashboard/leads/${id}?businessId=${biz.id}`, sales.cookie);
    assert.equal(page.status, 200);
    assert.ok(page.html.includes(`${RUN_TAG} sales lead`));
    assert.ok(!page.html.includes(">Delete</button>"), "sales should not see delete controls");
    assert.ok(!page.html.includes("Delete lead permanently?"), "sales should not see delete dialog");
  });
});

describe("lead tenant isolation", () => {
  it("Business B cannot read, mutate, search, or infer Business A's leads", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} crm-A`);
    const bizB = await createBusiness(b.cookie, `${RUN_TAG} crm-B`);

    const leadName = `${RUN_TAG} secret lead`;
    const created = await api("POST", `/api/businesses/${bizA.id}/leads`, {
      body: { name: leadName, status: "INTERESTED", campaignName: `${RUN_TAG} secret-camp` },
      cookie: a.cookie,
    });
    const leadA = created.json.lead.id;

    // Direct access through B's own workspace: 404, no leakage.
    for (const [method, path, body] of [
      ["GET", `/api/businesses/${bizB.id}/leads/${leadA}`, undefined],
      ["PATCH", `/api/businesses/${bizB.id}/leads/${leadA}`, { name: "hijack" }],
      ["DELETE", `/api/businesses/${bizB.id}/leads/${leadA}`, undefined],
    ]) {
      const r = await api(method, path, { body, cookie: b.cookie });
      assert.ok([404, 403].includes(r.status), `${method} ${path} -> ${r.status}`);
      assert.ok(!JSON.stringify(r.json).includes(leadName), "lead name leaked");
    }
    // Through A's workspace path: 403 membership denial.
    assert.equal((await api("GET", `/api/businesses/${bizA.id}/leads/${leadA}`, { cookie: b.cookie })).status, 403);

    // Search and list in B never surface A's rows.
    const searchB = await api("GET", `/api/businesses/${bizB.id}/leads?search=${RUN_TAG}`, { cookie: b.cookie });
    assert.equal(searchB.json.total, 0);
    const listB = await api("GET", `/api/businesses/${bizB.id}/leads`, { cookie: b.cookie });
    assert.ok(!JSON.stringify(listB.json).includes(leadName));

    // Details + list pages never render foreign data.
    const detailB = await getHtml(`/dashboard/leads/${leadA}?businessId=${bizB.id}`, b.cookie);
    assert.equal(detailB.status, 404);
    const listPageB = await getHtml(`/dashboard/leads?businessId=${bizB.id}`, b.cookie);
    assert.equal(listPageB.status, 200);
    assert.ok(!listPageB.html.includes(leadName));

    // A is unaffected and sees everything.
    const detailA = await getHtml(`/dashboard/leads/${leadA}?businessId=${bizA.id}`, a.cookie);
    assert.equal(detailA.status, 200);
    assert.ok(detailA.html.includes(leadName));
    const listPageA = await getHtml(`/dashboard/leads?businessId=${bizA.id}`, a.cookie);
    assert.ok(listPageA.html.includes(leadName));
  });
});
