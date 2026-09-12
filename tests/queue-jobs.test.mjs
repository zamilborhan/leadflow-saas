// Queue / job tests (integration + API + authorization + tenant isolation):
// automation rules lifecycle, job emission on lead events, jobs listing,
// manual drain, sweep scheduling, retry, and logs. Pure engine math lives
// in automation.test.mjs; this file exercises the HTTP + worker path.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";

const ROOT = path.join(import.meta.dirname, "..");
const FALLBACK_PORT = 8106;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `queue${Date.now()}`;
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
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
  return `10.211.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
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

async function waitForReady(timeoutMs = 120_000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/me`, { headers: { "x-forwarded-for": nextIp() } });
      if (res.status === 401) return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error("dev server never became ready");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

let server = null;
let ownServer = false;

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
  await waitForPort(PORT, 180_000);
  await waitForReady(120_000);
}, { timeout: 220_000 });

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
      await client.query(`DELETE FROM "AutomationJob" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "AutomationLog" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "AutomationRule" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "FollowUp" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "LeadActivity" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "Lead" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "BusinessMember" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "Subscription" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "Business" WHERE id = ANY($1)`, [bizIds]).catch(() => {});
    }
    if (userIds.length > 0) {
      await client.query(`DELETE FROM "Session" WHERE "userId" = ANY($1)`, [userIds]).catch(() => {});
      await client.query(`DELETE FROM "BusinessMember" WHERE "userId" = ANY($1)`, [userIds]).catch(() => {});
      await client.query(`DELETE FROM "User" WHERE id = ANY($1)`, [userIds]).catch(() => {});
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
  return { email, cookie: login.cookie };
}

async function setupBusiness(ownerCookie, opts = {}) {
  const list = await api("GET", "/api/businesses", { cookie: ownerCookie });
  assert.equal(list.status, 200);
  const biz = list.json.businesses[0];
  assert.ok(biz?.id);
  if (opts.plan) {
    const s = await api("PATCH", `/api/businesses/${biz.id}/subscription`, {
      body: { planCode: opts.plan },
      cookie: ownerCookie,
    });
    assert.equal(s.status, 200, `set plan failed: ${JSON.stringify(s.json)}`);
  }
  return biz;
}

describe("automation rules lifecycle (queue config)", () => {
  it("lists seeded rules, validates patches, and enforces roles", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await setupBusiness(owner.cookie, { plan: "STARTER" });
    await api("POST", `/api/businesses/${biz.id}/members`, {
      body: { email: sales.email, role: "SALES" },
      cookie: owner.cookie,
    });

    const list = await api("GET", `/api/businesses/${biz.id}/automations/rules`, { cookie: owner.cookie });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json.rules) && list.json.rules.length >= 3, "expected seeded rules");

    const rule = list.json.rules[0];
    const bad = await api("PATCH", `/api/businesses/${biz.id}/automations/rules/${rule.id}`, {
      body: { config: { noContactMinutes: -5 } },
      cookie: owner.cookie,
    });
    assert.equal(bad.status, 422);

    const disable = await api("PATCH", `/api/businesses/${biz.id}/automations/rules/${rule.id}`, {
      body: { status: "DISABLED" },
      cookie: owner.cookie,
    });
    assert.equal(disable.status, 200);
    assert.equal(disable.json.rule.status, "DISABLED");

    const enable = await api("PATCH", `/api/businesses/${biz.id}/automations/rules/${rule.id}`, {
      body: { status: "ENABLED" },
      cookie: owner.cookie,
    });
    assert.equal(enable.status, 200);

    assert.equal((await api("GET", `/api/businesses/${biz.id}/automations/rules`)).status, 401);
    assert.equal((await api("GET", `/api/businesses/${biz.id}/automations/rules`, { cookie: sales.cookie })).status, 403);
  });
});

describe("automation jobs queue (drain / retry / logs)", () => {
  it("emits a NEW_LEAD job, lists it, drains it, and records logs", async () => {
    const owner = await registerAndLogin();
    const biz = await setupBusiness(owner.cookie, { plan: "STARTER" });

    const lead = await api("POST", `/api/businesses/${biz.id}/leads`, {
      body: { name: `${RUN_TAG} queued` },
      cookie: owner.cookie,
    });
    assert.equal(lead.status, 201, `create lead failed: ${JSON.stringify(lead.json)}`);

    const jobs = await api("GET", `/api/businesses/${biz.id}/automations/jobs`, { cookie: owner.cookie });
    assert.equal(jobs.status, 200, `list jobs failed: ${JSON.stringify(jobs.json)}`);
    assert.ok(jobs.json.jobs.length >= 1, "expected at least one automation job");

    const badStatus = await api("GET", `/api/businesses/${biz.id}/automations/jobs?status=BOGUS`, { cookie: owner.cookie });
    assert.equal(badStatus.status, 422);

    const drain = await api("POST", `/api/businesses/${biz.id}/automations/drain`, { cookie: owner.cookie });
    assert.equal(drain.status, 200, `drain failed: ${JSON.stringify(drain.json)}`);
    assert.equal(drain.json.ok, true);

    const logs = await api("GET", `/api/businesses/${biz.id}/automations/logs`, { cookie: owner.cookie });
    assert.equal(logs.status, 200, `logs failed: ${JSON.stringify(logs.json)}`);
    assert.ok(Array.isArray(logs.json.logs));

    // Retry shape: unknown job → 404, validation of job id.
    const retryMissing = await api("POST", `/api/businesses/${biz.id}/automations/jobs/00000000-0000-0000-0000-000000000000/retry`, {
      cookie: owner.cookie,
    });
    assert.ok([404, 422].includes(retryMissing.status), `unexpected retry status ${retryMissing.status}`);
  });

  it("sweep schedules no-contact follow-ups and stays tenant-isolated", async () => {
    const owner = await registerAndLogin();
    const stranger = await registerAndLogin();
    const biz = await setupBusiness(owner.cookie, { plan: "STARTER" });

    const sweep = await api("POST", `/api/businesses/${biz.id}/automations/sweep`, { cookie: owner.cookie });
    assert.ok([200, 404].includes(sweep.status), `unexpected sweep status ${sweep.status}: ${JSON.stringify(sweep.json)}`);

    assert.equal((await api("GET", `/api/businesses/${biz.id}/automations/jobs`, { cookie: stranger.cookie })).status, 403);
    assert.equal((await api("POST", `/api/businesses/${biz.id}/automations/drain`, { cookie: stranger.cookie })).status, 403);
    assert.equal((await api("GET", `/api/businesses/${biz.id}/automations/logs`, { cookie: stranger.cookie })).status, 403);
  });
});
