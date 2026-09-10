// Tenant-isolation HTTP end-to-end tests against a throwaway `next dev`
// server: the acceptance criterion for multi-tenancy.
//
// Acceptance: Business A creates Lead A; Business B logs in; Business B
// cannot query, access, edit, delete, or infer Lead A.
//
// Pure policy unit tests live in tests/tenant-unit.test.mjs (no server).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";
const ROOT = path.join(import.meta.dirname, "..");
// Port selection: reuse an already-running dev server when present (Next.js
// refuses a second `dev` in the same directory), else boot our own.
// NOTE: ports 3000-3999 refuse binds in this sandbox (EACCES); 8080+ works.
const FALLBACK_PORT = 8091;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `tenant${Date.now()}`;
let seq = 0;

const testEmail = () => `${RUN_TAG}+${seq++}@example.invalid`;
const PASSWORD = "correct horse battery staple 12";
let callNo = 0;

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
  // Distinct client IP per call: the dev server rate-limits per IP
  // (in-memory) and the server may be shared across test runs. Tenancy is
  // what this file verifies — each call simulates a distinct client so
  // rate budgets never interfere with isolation assertions.
  callNo += 1;
  headers["x-forwarded-for"] = `10.99.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
  const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: payload, redirect: "manual" });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, cookie: sessionCookieFrom(res) };
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
  // Reuse the running dev server when one is already up (same-dir `next
  // dev` instances conflict); only spawn when no server answers.
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
  // Cleanup every row this run created (children first, then parents).
  const client = pg();
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT id FROM "User" WHERE email LIKE '${RUN_TAG}%'`);
    const userIds = rows.map((r) => r.id);
    const biz = await client.query(
      `SELECT id FROM "Business" WHERE name LIKE '${RUN_TAG}%'`
    );
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
      await client.query(`DELETE FROM "EmailVerificationToken" WHERE "userId" = ANY($1)`, [userIds]);
      await client.query(`DELETE FROM "OAuthAccount" WHERE "userId" = ANY($1)`, [userIds]);
      await client.query(`DELETE FROM "PasswordResetToken" WHERE "userId" = ANY($1)`, [userIds]);
      await client.query(`DELETE FROM "Session" WHERE "userId" = ANY($1)`, [userIds]);
      // Members referencing users of other (non-tagged) businesses would
      // already be gone via business cleanup; remove stragglers by user.
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

async function createBusiness(cookie, name, plan = "GROWTH") {
  // Registration auto-creates the workspace (FREE quota); adopt it and set
  // the plan context the test needs. `name` is kept for call-site parity.
  void name;
  const list = await api("GET", "/api/businesses", { cookie });
  assert.equal(list.status, 200);
  assert.ok(list.json.businesses.length >= 1, "expected auto-created workspace");
  const biz = list.json.businesses[0];
  // Quota context: isolation tests invite extra members, which exceeds FREE.
  if (plan) {
    const s = await api("PATCH", `/api/businesses/${biz.id}/subscription`, {
      body: { planCode: plan },
      cookie,
    });
    assert.equal(s.status, 200, `set plan failed: ${JSON.stringify(s.json)}`);
  }
  return biz;
}

async function createLead(cookie, businessId, payload) {
  return api("POST", `/api/businesses/${businessId}/leads`, { body: payload, cookie });
}

describe("tenant isolation acceptance", () => {
  it("Business A creates Lead A; Business B cannot query, access, edit, delete, or infer it", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();

    const bizA = await createBusiness(a.cookie, `${RUN_TAG} business A`);
    const bizB = await createBusiness(b.cookie, `${RUN_TAG} business B`);

    const leadName = `${RUN_TAG} lead A secret`;
    const created = await createLead(a.cookie, bizA.id, { name: leadName, email: "vip@example.com" });
    assert.equal(created.status, 201, `create lead failed: ${JSON.stringify(created.json)}`);
    const leadA = created.json.lead;
    assert.equal(leadA.businessId, bizA.id);

    // --- B cannot QUERY: B's own lead list must not contain Lead A. ---
    const bList = await api("GET", `/api/businesses/${bizB.id}/leads`, { cookie: b.cookie });
    assert.equal(bList.status, 200);
    assert.ok(Array.isArray(bList.json.leads));
    assert.equal(bList.json.leads.length, 0);
    assert.ok(!JSON.stringify(bList.json).includes(leadName));

    // --- B cannot ACCESS via its own workspace path (scoped id lookup → 404). ---
    const viaOwn = await api("GET", `/api/businesses/${bizB.id}/leads/${leadA.id}`, { cookie: b.cookie });
    assert.equal(viaOwn.status, 404);
    assert.ok(!JSON.stringify(viaOwn.json).includes(leadName));

    // --- B cannot ACCESS via A's workspace path (not a member → 403, no data). ---
    const viaForeign = await api("GET", `/api/businesses/${bizA.id}/leads/${leadA.id}`, { cookie: b.cookie });
    assert.equal(viaForeign.status, 403);
    assert.ok(!JSON.stringify(viaForeign.json).includes(leadName));

    // --- B cannot LIST A's workspace (403, no lead data leaked). ---
    const foreignList = await api("GET", `/api/businesses/${bizA.id}/leads`, { cookie: b.cookie });
    assert.equal(foreignList.status, 403);
    assert.ok(!JSON.stringify(foreignList.json).includes(leadName));

    // --- B cannot EDIT Lead A through either path. ---
    const editOwn = await api("PATCH", `/api/businesses/${bizB.id}/leads/${leadA.id}`, {
      body: { name: "hijacked" },
      cookie: b.cookie,
    });
    assert.equal(editOwn.status, 404);
    const editForeign = await api("PATCH", `/api/businesses/${bizA.id}/leads/${leadA.id}`, {
      body: { name: "hijacked" },
      cookie: b.cookie,
    });
    assert.equal(editForeign.status, 403);

    // --- B cannot DELETE Lead A through either path. ---
    const delOwn = await api("DELETE", `/api/businesses/${bizB.id}/leads/${leadA.id}`, { cookie: b.cookie });
    assert.equal(delOwn.status, 404);
    const delForeign = await api("DELETE", `/api/businesses/${bizA.id}/leads/${leadA.id}`, { cookie: b.cookie });
    assert.equal(delForeign.status, 403);

    // --- Lead A is untouched: A can still read its exact original data. ---
    const reread = await api("GET", `/api/businesses/${bizA.id}/leads/${leadA.id}`, { cookie: a.cookie });
    assert.equal(reread.status, 200);
    assert.equal(reread.json.lead.name, leadName);
    assert.equal(reread.json.lead.businessId, bizA.id);
  });

  it("unauthenticated callers cannot touch business resources", async () => {
    const a = await registerAndLogin();
    const biz = await createBusiness(a.cookie, `${RUN_TAG} private biz`);
    const created = await createLead(a.cookie, biz.id, { name: `${RUN_TAG} private lead` });
    const leadId = created.json.lead.id;

    assert.equal((await api("GET", "/api/businesses")).status, 401);
    assert.equal((await api("GET", `/api/businesses/${biz.id}/leads/${leadId}`)).status, 401);
    assert.equal((await api("GET", `/api/businesses/${biz.id}/leads`)).status, 401);
  });

  it("a user in two businesses sees strictly scoped leads per workspace", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} multi A`);
    const bizB = await createBusiness(b.cookie, `${RUN_TAG} multi B`);

    // B invites A as SALES into B.
    const invite = await api("POST", `/api/businesses/${bizB.id}/members`, {
      body: { email: a.email, role: "SALES" },
      cookie: b.cookie,
    });
    assert.equal(invite.status, 201, `invite failed: ${JSON.stringify(invite.json)}`);

    const leadAName = `${RUN_TAG} only-in-A`;
    const leadBName = `${RUN_TAG} only-in-B`;
    assert.equal((await createLead(a.cookie, bizA.id, { name: leadAName })).status, 201);
    assert.equal((await createLead(b.cookie, bizB.id, { name: leadBName })).status, 201);

    // Same user A, two workspaces: each list shows only its own leads.
    const listA = await api("GET", `/api/businesses/${bizA.id}/leads`, { cookie: a.cookie });
    assert.equal(listA.status, 200);
    assert.ok(listA.json.leads.some((l) => l.name === leadAName));
    assert.ok(!listA.json.leads.some((l) => l.name === leadBName));

    const listB = await api("GET", `/api/businesses/${bizB.id}/leads`, { cookie: a.cookie });
    assert.equal(listB.status, 200);
    assert.ok(listB.json.leads.some((l) => l.name === leadBName));
    assert.ok(!listB.json.leads.some((l) => l.name === leadAName));

    // A's workspace switcher lists both businesses.
    const mine = await api("GET", "/api/businesses", { cookie: a.cookie });
    assert.equal(mine.status, 200);
    const ids = mine.json.businesses.map((x) => x.id);
    assert.ok(ids.includes(bizA.id) && ids.includes(bizB.id));
  });

  it("role policies: SALES cannot manage members or delete leads; ADMIN cannot touch OWNER", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const admin = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} roles biz`);

    for (const [email, role] of [[sales.email, "SALES"], [admin.email, "ADMIN"]]) {
      const r = await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email, role },
        cookie: owner.cookie,
      });
      assert.equal(r.status, 201, `invite ${role} failed: ${JSON.stringify(r.json)}`);
    }

    // SALES cannot invite.
    const outsider = testEmail();
    await api("POST", "/api/auth/register", { body: { email: outsider, password: PASSWORD } });
    const salesInvite = await api("POST", `/api/businesses/${biz.id}/members`, {
      body: { email: outsider, role: "SALES" },
      cookie: sales.cookie,
    });
    assert.equal(salesInvite.status, 403);

    // SALES cannot delete a lead (owner creates one first).
    const created = await createLead(owner.cookie, biz.id, { name: `${RUN_TAG} deletable` });
    const leadId = created.json.lead.id;
    assert.equal(
      (await api("DELETE", `/api/businesses/${biz.id}/leads/${leadId}`, { cookie: sales.cookie })).status,
      403
    );

    // SALES can still do the daily workflow: create + update.
    const sCreate = await createLead(sales.cookie, biz.id, { name: `${RUN_TAG} sales lead` });
    assert.equal(sCreate.status, 201);
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/leads/${sCreate.json.lead.id}`, {
        body: { status: "CONTACTED" },
        cookie: sales.cookie,
      })).status,
      200
    );

    // ADMIN cannot demote the OWNER, and cannot invite an OWNER.
    // Member routes address users by userId; resolve owner's id via members list.
    const members = await api("GET", `/api/businesses/${biz.id}/members`, { cookie: owner.cookie });
    const ownerMember = members.json.members.find((m) => m.role === "OWNER");
    assert.ok(ownerMember);
    const demote = await api("PATCH", `/api/businesses/${biz.id}/members/${ownerMember.userId}`, {
      body: { role: "SALES" },
      cookie: admin.cookie,
    });
    assert.equal(demote.status, 403);
    const inviteOwner = await api("POST", `/api/businesses/${biz.id}/members`, {
      body: { email: outsider, role: "OWNER" },
      cookie: admin.cookie,
    });
    assert.equal(inviteOwner.status, 403);
  });
});
