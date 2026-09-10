// Dashboard tenant-scoping tests: server-rendered HTML must never leak
// cross-tenant data, and empty states must render for fresh workspaces.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";

const ROOT = path.join(import.meta.dirname, "..");
const FALLBACK_PORT = 8093;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `dash${Date.now()}`;
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
  headers["x-forwarded-for"] = `10.97.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
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
      "x-forwarded-for": `10.97.${Math.floor(callNo / 250) % 250}.${callNo % 250}`,
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
  const login = await api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.ok(login.cookie);
  // Registration auto-creates exactly one workspace (FREE quota).
  assert.ok(reg.json.businessId, "register must return the auto-created businessId");
  return { email, cookie: login.cookie, businessId: reg.json.businessId };
}

describe("dashboard tenant scoping", () => {
  it("shows A's leads to A, hides them from B, handles empty workspaces", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const c = await registerAndLogin();

    // Each user owns their auto-created workspace; distinct by id.
    const bizA = { id: a.businessId };
    const bizB = { id: b.businessId };
    assert.notEqual(bizA.id, bizB.id);

    const leadName = `${RUN_TAG}-vip-lead-A`;
    const created = await api("POST", `/api/businesses/${bizA.id}/leads`, {
      body: { name: leadName, status: "INTERESTED", source: "facebook" },
      cookie: a.cookie,
    });
    assert.equal(created.status, 201);

    // A sees their workspace data: lead, live counters.
    const pageA = await getHtml(`/dashboard?businessId=${bizA.id}`, a.cookie);
    assert.equal(pageA.status, 200);
    assert.ok(pageA.html.includes(leadName), "A dashboard missing own lead");
    assert.ok(pageA.html.includes("Total leads"), "A dashboard missing stat cards");
    assert.ok(pageA.html.includes("Conversion rate"), "A dashboard missing conversion rate");

    // B requests A's workspace explicitly: falls back to B's own data, leaks nothing.
    const pageB = await getHtml(`/dashboard?businessId=${bizA.id}`, b.cookie);
    assert.equal(pageB.status, 200);
    assert.ok(!pageB.html.includes(leadName), "B dashboard leaked A's lead");

    // B's own dashboard shows zeroed counters and the empty-state table.
    const pageBOwn = await getHtml(`/dashboard?businessId=${bizB.id}`, b.cookie);
    assert.equal(pageBOwn.status, 200);
    assert.ok(pageBOwn.html.includes("No leads yet"), "B dashboard missing empty state");

    // C's fresh auto workspace: empty state, no crash, no foreign data.
    const pageC = await getHtml("/dashboard", c.cookie);
    assert.equal(pageC.status, 200);
    assert.ok(pageC.html.includes("No leads yet"), "fresh dashboard missing empty state");
    assert.ok(!pageC.html.includes(leadName), "fresh dashboard leaked A's lead");
  });

  it("redirects unauthenticated visitors to login", async () => {
    const res = await getHtml("/dashboard", undefined);
    assert.ok([301, 302, 307, 308].includes(res.status), `expected redirect, got ${res.status}`);
    assert.match(res.location ?? "", /\/login/);
  });
});
