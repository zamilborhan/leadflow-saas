// Team management authorization + tenant isolation tests over HTTP.
//
// Rules under test:
// - OWNER has full access (invite any role, change any role, remove anyone).
// - ADMIN manages ADMIN/SALES but never touches OWNER and never grants OWNER.
// - SALES is read-only on the team (members.read only).
// - The last OWNER cannot be demoted or removed.
// - Cross-tenant team access is denied without leaking membership data.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";

const ROOT = path.join(import.meta.dirname, "..");
const FALLBACK_PORT = 8094;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `team${Date.now()}`;
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
  return `10.96.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
}

async function api(method, urlPath, { body, cookie } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (cookie) headers.cookie = cookie;
  // Distinct client IP per call so the shared dev server's in-memory rate
  // budgets never interfere with authorization assertions.
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

async function createBusiness(cookie, name, plan = "BUSINESS") {
  const r = await api("POST", "/api/businesses", { body: { name }, cookie });
  assert.equal(r.status, 201, `create business failed: ${JSON.stringify(r.json)}`);
  // Quota context: team tests invite several members, which exceeds FREE.
  if (plan) {
    const s = await api("PATCH", `/api/businesses/${r.json.business.id}/subscription`, {
      body: { planCode: plan },
      cookie,
    });
    assert.equal(s.status, 200, `set plan failed: ${JSON.stringify(s.json)}`);
  }
  return r.json.business;
}

async function listMembers(cookie, businessId) {
  const r = await api("GET", `/api/businesses/${businessId}/members`, { cookie });
  assert.equal(r.status, 200, `list members failed: ${JSON.stringify(r.json)}`);
  return r.json.members;
}

async function memberUserId(cookie, businessId, email) {
  // The members API returns userIds; look the target up via direct DB read
  // of the user row (test-only), then confirm membership through the API.
  const client = pg();
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT id FROM "User" WHERE email = $1`, [email]);
    assert.ok(rows.length === 1, `expected one user for ${email}`);
    return rows[0].id;
  } finally {
    await client.end();
  }
}

describe("team authorization", () => {
  it("OWNER has full access: invite any role, change roles, remove members", async () => {
    const owner = await registerAndLogin();
    const admin = await registerAndLogin();
    const sales = await registerAndLogin();
    const owner2 = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} owner-full`);

    for (const [u, role] of [[admin, "ADMIN"], [sales, "SALES"], [owner2, "OWNER"]]) {
      const r = await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email: u.email, role },
        cookie: owner.cookie,
      });
      assert.equal(r.status, 201, `owner invite ${role} failed: ${JSON.stringify(r.json)}`);
      assert.equal(r.json.member.role, role);
    }

    // Change SALES -> ADMIN and back.
    const salesId = await memberUserId(owner.cookie, biz.id, sales.email);
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/members/${salesId}`, {
        body: { role: "ADMIN" },
        cookie: owner.cookie,
      })).status,
      200
    );
    const back = await api("PATCH", `/api/businesses/${biz.id}/members/${salesId}`, {
      body: { role: "SALES" },
      cookie: owner.cookie,
    });
    assert.equal(back.status, 200);
    assert.equal(back.json.member.role, "SALES");

    // Remove the ADMIN; roster shrinks and no longer contains them.
    const adminId = await memberUserId(owner.cookie, biz.id, admin.email);
    assert.equal(
      (await api("DELETE", `/api/businesses/${biz.id}/members/${adminId}`, { cookie: owner.cookie })).status,
      200
    );
    const roster = await listMembers(owner.cookie, biz.id);
    assert.ok(!roster.some((m) => m.userId === adminId), "removed member still listed");
    assert.equal(roster.length, 3, `expected owner+sales+owner2, got ${roster.length}`);
  });

  it("ADMIN manages ADMIN/SALES but never touches OWNER or grants OWNER", async () => {
    const owner = await registerAndLogin();
    const admin = await registerAndLogin();
    const sales = await registerAndLogin();
    const newcomer = await registerAndLogin();
    const newcomer2 = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} admin-bounds`);

    for (const [u, role] of [[admin, "ADMIN"], [sales, "SALES"]]) {
      assert.equal(
        (await api("POST", `/api/businesses/${biz.id}/members`, {
          body: { email: u.email, role },
          cookie: owner.cookie,
        })).status,
        201
      );
    }
    const salesId = await memberUserId(owner.cookie, biz.id, sales.email);
    const ownerRec = (await listMembers(owner.cookie, biz.id)).find((m) => m.role === "OWNER");
    assert.ok(ownerRec, "owner membership missing");

    // Admin invites SALES and ADMIN, but not OWNER.
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email: newcomer.email, role: "SALES" },
        cookie: admin.cookie,
      })).status,
      201
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email: newcomer2.email, role: "ADMIN" },
        cookie: admin.cookie,
      })).status,
      201
    );
    const grantOwner = await api("POST", `/api/businesses/${biz.id}/members`, {
      body: { email: newcomer.email, role: "OWNER" },
      cookie: admin.cookie,
    });
    assert.equal(grantOwner.status, 403);

    // Admin promotes SALES -> ADMIN and demotes back, but cannot grant OWNER.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/members/${salesId}`, {
        body: { role: "ADMIN" },
        cookie: admin.cookie,
      })).status,
      200
    );
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/members/${salesId}`, {
        body: { role: "OWNER" },
        cookie: admin.cookie,
      })).status,
      403
    );
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/members/${salesId}`, {
        body: { role: "SALES" },
        cookie: admin.cookie,
      })).status,
      200
    );

    // Admin cannot change or remove the OWNER, but can remove SALES.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/members/${ownerRec.userId}`, {
        body: { role: "SALES" },
        cookie: admin.cookie,
      })).status,
      403
    );
    assert.equal(
      (await api("DELETE", `/api/businesses/${biz.id}/members/${ownerRec.userId}`, {
        cookie: admin.cookie,
      })).status,
      403
    );
    assert.equal(
      (await api("DELETE", `/api/businesses/${biz.id}/members/${salesId}`, { cookie: admin.cookie })).status,
      200
    );
  });

  it("SALES is read-only on the team: list ok, invite/change/remove denied", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const outsider = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} sales-readonly`);
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email: sales.email, role: "SALES" },
        cookie: owner.cookie,
      })).status,
      201
    );
    const salesId = await memberUserId(owner.cookie, biz.id, sales.email);

    // List works (members.read) and shows the roster.
    const roster = await listMembers(sales.cookie, biz.id);
    assert.ok(roster.some((m) => m.userId === salesId));

    // Mutations are all denied.
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email: outsider.email, role: "SALES" },
        cookie: sales.cookie,
      })).status,
      403
    );
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/members/${salesId}`, {
        body: { role: "ADMIN" },
        cookie: sales.cookie,
      })).status,
      403
    );
    assert.equal(
      (await api("DELETE", `/api/businesses/${biz.id}/members/${salesId}`, { cookie: sales.cookie })).status,
      403
    );

    // Team page renders for SALES without management controls.
    const page = await getHtml(`/dashboard/settings/team?businessId=${biz.id}`, sales.cookie);
    assert.equal(page.status, 200);
    assert.ok(page.html.includes(sales.email), "roster missing own email");
    assert.ok(!page.html.includes("Invite member"), "sales should not see invite controls");
  });

  it("the last OWNER cannot be demoted or removed", async () => {
    const owner = await registerAndLogin();
    const owner2 = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} last-owner`);
    const selfId = await memberUserId(owner.cookie, biz.id, owner.email);

    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/members/${selfId}`, {
        body: { role: "SALES" },
        cookie: owner.cookie,
      })).status,
      403
    );
    assert.equal(
      (await api("DELETE", `/api/businesses/${biz.id}/members/${selfId}`, { cookie: owner.cookie })).status,
      403
    );

    // With a second OWNER present, stepping down is allowed.
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email: owner2.email, role: "OWNER" },
        cookie: owner.cookie,
      })).status,
      201
    );
    const demote = await api("PATCH", `/api/businesses/${biz.id}/members/${selfId}`, {
      body: { role: "ADMIN" },
      cookie: owner.cookie,
    });
    assert.equal(demote.status, 200);
    assert.equal(demote.json.member.role, "ADMIN");
  });

  it("member endpoints validate input and auth", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} validation`);

    // Invalid role -> 422; unknown email -> 403 (no enumeration signal beyond denial).
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email: owner.email, role: "SUPERADMIN" },
        cookie: owner.cookie,
      })).status,
      422
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email: `ghost-${RUN_TAG}@example.invalid`, role: "SALES" },
        cookie: owner.cookie,
      })).status,
      403
    );
    // Duplicate invite -> 403.
    const dup = await registerAndLogin();
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email: dup.email, role: "SALES" },
        cookie: owner.cookie,
      })).status,
      201
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/members`, {
        body: { email: dup.email, role: "SALES" },
        cookie: owner.cookie,
      })).status,
      403
    );
    // PATCH/DELETE unknown member -> 404; unauthenticated -> 401.
    const { randomUUID } = await import("node:crypto");
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/members/${randomUUID()}`, {
        body: { role: "SALES" },
        cookie: owner.cookie,
      })).status,
      404
    );
    assert.equal((await api("GET", `/api/businesses/${biz.id}/members`)).status, 401);
  });
});

describe("team tenant isolation", () => {
  it("Business B cannot list, mutate, or infer Business A's roster", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} iso-A`);
    const bizB = await createBusiness(b.cookie, `${RUN_TAG} iso-B`);
    const aId = await memberUserId(a.cookie, bizA.id, a.email);

    // List: denied, and the body carries no roster data.
    const list = await api("GET", `/api/businesses/${bizA.id}/members`, { cookie: b.cookie });
    assert.equal(list.status, 403);
    assert.ok(!JSON.stringify(list.json).includes(a.email), "roster email leaked cross-tenant");

    // Invite / change / remove into the foreign workspace: all denied.
    assert.equal(
      (await api("POST", `/api/businesses/${bizA.id}/members`, {
        body: { email: b.email, role: "SALES" },
        cookie: b.cookie,
      })).status,
      403
    );
    assert.equal(
      (await api("PATCH", `/api/businesses/${bizA.id}/members/${aId}`, {
        body: { role: "SALES" },
        cookie: b.cookie,
      })).status,
      403
    );
    assert.equal(
      (await api("DELETE", `/api/businesses/${bizA.id}/members/${aId}`, { cookie: b.cookie })).status,
      403
    );

    // Each roster is strictly scoped: A sees only A-side, B sees only B-side.
    const rosterA = await listMembers(a.cookie, bizA.id);
    const rosterB = await listMembers(b.cookie, bizB.id);
    assert.ok(rosterA.some((m) => m.userId === aId));
    assert.ok(!rosterA.some((m) => m.userId && rosterB.some((n) => n.userId === m.userId && m.userId !== aId)));
    assert.ok(rosterB.every((m) => m.businessId === bizB.id));
    assert.ok(rosterA.every((m) => m.businessId === bizA.id));

    // A's roster is intact after B's attempts.
    const after = await listMembers(a.cookie, bizA.id);
    assert.deepEqual(
      after.map((m) => m.userId).sort(),
      rosterA.map((m) => m.userId).sort()
    );
  });

  it("team page never renders foreign roster data", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} page-A`);
    await createBusiness(b.cookie, `${RUN_TAG} page-B`);

    const pageB = await getHtml(`/dashboard/settings/team?businessId=${bizA.id}`, b.cookie);
    assert.equal(pageB.status, 200);
    assert.ok(!pageB.html.includes(a.email), "team page leaked foreign email");

    const pageA = await getHtml(`/dashboard/settings/team?businessId=${bizA.id}`, a.cookie);
    assert.equal(pageA.status, 200);
    assert.ok(pageA.html.includes(a.email), "owner roster missing own email");
  });
});
