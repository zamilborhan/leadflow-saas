// Lead activity history + notes tests: auto-emitted events, manual
// logging, note validation, sales permission boundaries, tenant isolation,
// and timeline/notes rendering — all over HTTP.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";

const ROOT = path.join(import.meta.dirname, "..");
const FALLBACK_PORT = 8096;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `act${Date.now()}`;
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
  return `10.94.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
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
  // Isolation: default NEW_LEAD automations would reassign leads and append
  // timeline entries, breaking exact-count assertions below.
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

async function activities(cookie, businessId, leadId, qs = "") {
  const r = await api("GET", `/api/businesses/${businessId}/leads/${leadId}/activities${qs}`, { cookie });
  assert.equal(r.status, 200, `list activities failed: ${JSON.stringify(r.json)}`);
  return r.json.activities;
}

describe("automatic activity events", () => {
  it("records created, assigned, and status-changed events with the actor", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} auto`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    const ownerId = await userIdByEmail(owner.email);
    const salesId = await userIdByEmail(sales.email);

    // Create unassigned: exactly one CREATED event by the creator.
    const created = await api("POST", `/api/businesses/${biz.id}/leads`, {
      body: { name: `${RUN_TAG} auto lead`, source: "facebook" },
      cookie: owner.cookie,
    });
    assert.equal(created.status, 201);
    const leadId = created.json.lead.id;
    let timeline = await activities(owner.cookie, biz.id, leadId);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].type, "CREATED");
    assert.equal(timeline[0].actorId, ownerId);
    assert.equal(timeline[0].businessId, biz.id);
    assert.equal(timeline[0].leadId, leadId);

    // Assign: ASSIGNED event by the assigner.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/leads/${leadId}`, {
        body: { assignedTo: salesId },
        cookie: owner.cookie,
      })).status,
      200
    );
    timeline = await activities(owner.cookie, biz.id, leadId);
    const assigned = timeline.find((a) => a.type === "ASSIGNED");
    assert.ok(assigned, "missing ASSIGNED event");
    assert.equal(assigned.actorId, ownerId);

    // Status change: STATUS_CHANGED with the transition in the body.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/leads/${leadId}`, {
        body: { status: "CONTACTED" },
        cookie: sales.cookie,
      })).status,
      200
    );
    timeline = await activities(owner.cookie, biz.id, leadId);
    const changed = timeline.find((a) => a.type === "STATUS_CHANGED");
    assert.ok(changed, "missing STATUS_CHANGED event");
    assert.equal(changed.body, "NEW → CONTACTED");
    assert.equal(changed.actorId, salesId, "actor must be the performer");

    // Unassign: ASSIGNED event noting the removal.
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/leads/${leadId}`, {
        body: { assignedTo: null },
        cookie: owner.cookie,
      })).status,
      200
    );
    timeline = await activities(owner.cookie, biz.id, leadId);
    assert.ok(timeline.some((a) => a.type === "ASSIGNED" && a.body === "Unassigned"));

    // No-op patch (same status) emits nothing new.
    const before = timeline.length;
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/leads/${leadId}`, {
        body: { status: "CONTACTED" },
        cookie: owner.cookie,
      })).status,
      200
    );
    timeline = await activities(owner.cookie, biz.id, leadId);
    assert.equal(timeline.length, before, "no-op patch should not append events");
  });
});

describe("notes", () => {
  it("creates notes with NOTE_ADDED timeline entries, newest first", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} notes`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    const leadId = (
      await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: `${RUN_TAG} noted lead` },
        cookie: owner.cookie,
      })
    ).json.lead.id;

    const first = `${RUN_TAG} first note body`;
    const n1 = await api("POST", `/api/businesses/${biz.id}/leads/${leadId}/notes`, {
      body: { body: first },
      cookie: sales.cookie,
    });
    assert.equal(n1.status, 201, `create note failed: ${JSON.stringify(n1.json)}`);
    assert.equal(n1.json.note.body, first);
    const salesId = await userIdByEmail(sales.email);
    assert.equal(n1.json.note.authorId, salesId);

    const second = `${RUN_TAG} second note body`;
    await api("POST", `/api/businesses/${biz.id}/leads/${leadId}/notes`, {
      body: { body: second },
      cookie: owner.cookie,
    });

    const listed = await api("GET", `/api/businesses/${biz.id}/leads/${leadId}/notes`, { cookie: owner.cookie });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.notes.length, 2);
    assert.equal(listed.json.notes[0].body, second, "notes must be newest first");
    assert.equal(listed.json.notes[1].body, first);

    // Each note mirrored exactly once in the timeline.
    const timeline = await activities(owner.cookie, biz.id, leadId);
    const noteEvents = timeline.filter((a) => a.type === "NOTE_ADDED");
    assert.equal(noteEvents.length, 2);
    assert.ok(noteEvents.some((a) => a.body === first && a.actorId === salesId));
  });

  it("validates note input", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} note-validation`);
    const leadId = (
      await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: `${RUN_TAG} v lead` },
        cookie: owner.cookie,
      })
    ).json.lead.id;

    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads/${leadId}/notes`, { body: {}, cookie: owner.cookie })).status,
      422
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads/${leadId}/notes`, {
        body: { body: "   " },
        cookie: owner.cookie,
      })).status,
      422
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads/${leadId}/notes`, {
        body: { body: "x".repeat(2001) },
        cookie: owner.cookie,
      })).status,
      422
    );
    const { randomUUID } = await import("node:crypto");
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads/${randomUUID()}/notes`, {
        body: { body: "ghost" },
        cookie: owner.cookie,
      })).status,
      404
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads/${leadId}/notes`, { body: { body: "anon" } })).status,
      401
    );
  });
});

describe("manual activity logging", () => {
  it("accepts follow-up/WhatsApp events and rejects system types", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} manual`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    const leadId = (
      await api("POST", `/api/businesses/${biz.id}/leads`, {
        body: { name: `${RUN_TAG} manual lead` },
        cookie: owner.cookie,
      })
    ).json.lead.id;

    const fu = await api("POST", `/api/businesses/${biz.id}/leads/${leadId}/activities`, {
      body: { type: "FOLLOW_UP_CREATED", body: "Call scheduled" },
      cookie: sales.cookie,
    });
    assert.equal(fu.status, 201, `log follow-up failed: ${JSON.stringify(fu.json)}`);
    assert.equal(fu.json.activity.type, "FOLLOW_UP_CREATED");
    assert.equal(fu.json.activity.body, "Call scheduled");
    const salesId = await userIdByEmail(sales.email);
    assert.equal(fu.json.activity.actorId, salesId, "actor must be the caller, never spoofed");

    // Body is optional.
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads/${leadId}/activities`, {
        body: { type: "WHATSAPP_RECEIVED" },
        cookie: owner.cookie,
      })).status,
      201
    );

    // System-emitted types cannot be forged; unknown types rejected.
    for (const type of ["CREATED", "ASSIGNED", "STATUS_CHANGED", "NOTE_ADDED", "BOGUS"]) {
      const r = await api("POST", `/api/businesses/${biz.id}/leads/${leadId}/activities`, {
        body: { type },
        cookie: owner.cookie,
      });
      assert.equal(r.status, 422, `type ${type} should be rejected`);
    }

    // Type filter narrows the timeline.
    const filtered = await activities(owner.cookie, biz.id, leadId, "?type=FOLLOW_UP_CREATED");
    assert.ok(filtered.length >= 1);
    assert.ok(filtered.every((a) => a.type === "FOLLOW_UP_CREATED"));
  });
});

describe("activity tenant isolation", () => {
  it("Business B cannot read, write, or infer Business A's history", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} hist-A`);
    const bizB = await createBusiness(b.cookie, `${RUN_TAG} hist-B`);

    const noteBody = `${RUN_TAG} secret note`;
    const leadA = (
      await api("POST", `/api/businesses/${bizA.id}/leads`, {
        body: { name: `${RUN_TAG} secret lead` },
        cookie: a.cookie,
      })
    ).json.lead.id;
    assert.equal(
      (await api("POST", `/api/businesses/${bizA.id}/leads/${leadA}/notes`, {
        body: { body: noteBody },
        cookie: a.cookie,
      })).status,
      201
    );

    // Reads through B's own workspace: 404 with no data.
    for (const suffix of ["activities", "notes"]) {
      const r = await api("GET", `/api/businesses/${bizB.id}/leads/${leadA}/${suffix}`, { cookie: b.cookie });
      assert.equal(r.status, 404, `GET ${suffix} should be 404`);
      assert.ok(!JSON.stringify(r.json).includes(noteBody), `${suffix} leaked note body`);
    }
    // Reads through A's workspace path: 403 membership denial.
    for (const suffix of ["activities", "notes"]) {
      const r = await api("GET", `/api/businesses/${bizA.id}/leads/${leadA}/${suffix}`, { cookie: b.cookie });
      assert.equal(r.status, 403, `GET ${suffix} should be 403`);
    }
    // Writes are denied both ways.
    assert.equal(
      (await api("POST", `/api/businesses/${bizB.id}/leads/${leadA}/notes`, {
        body: { body: "hijack" },
        cookie: b.cookie,
      })).status,
      404
    );
    assert.equal(
      (await api("POST", `/api/businesses/${bizA.id}/leads/${leadA}/notes`, {
        body: { body: "hijack" },
        cookie: b.cookie,
      })).status,
      403
    );
    assert.equal(
      (await api("POST", `/api/businesses/${bizB.id}/leads/${leadA}/activities`, {
        body: { type: "WHATSAPP_SENT" },
        cookie: b.cookie,
      })).status,
      404
    );

    // B's own timeline is unaffected; A's history intact with B absent.
    const ownLead = (
      await api("POST", `/api/businesses/${bizB.id}/leads`, {
        body: { name: `${RUN_TAG} b lead` },
        cookie: b.cookie,
      })
    ).json.lead.id;
    const bTimeline = await activities(b.cookie, bizB.id, ownLead);
    assert.ok(!JSON.stringify(bTimeline).includes(noteBody));
    const aTimeline = await activities(a.cookie, bizA.id, leadA);
    assert.ok(aTimeline.some((e) => e.type === "NOTE_ADDED" && e.body === noteBody));
    assert.equal(aTimeline.length, 2, `expected CREATED + NOTE_ADDED, got ${aTimeline.length}`);
  });

  it("details page shows history to members and 404 to outsiders", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} page-A`);
    await createBusiness(b.cookie, `${RUN_TAG} page-B`);

    const leadName = `${RUN_TAG} timeline lead`;
    const noteBody = `${RUN_TAG} visible note`;
    const leadA = (
      await api("POST", `/api/businesses/${bizA.id}/leads`, { body: { name: leadName }, cookie: a.cookie })
    ).json.lead.id;
    await api("POST", `/api/businesses/${bizA.id}/leads/${leadA}/notes`, {
      body: { body: noteBody },
      cookie: a.cookie,
    });

    const pageA = await getHtml(`/dashboard/leads/${leadA}?businessId=${bizA.id}`, a.cookie);
    assert.equal(pageA.status, 200);
    assert.ok(pageA.html.includes("Activity timeline"), "timeline section missing");
    assert.ok(pageA.html.includes(noteBody), "note body missing from page");
    assert.ok(pageA.html.includes(a.email), "actor email missing from page");
    assert.ok(pageA.html.includes("Notes"), "notes section missing");

    const pageB = await getHtml(`/dashboard/leads/${leadA}?businessId=${bizA.id}`, b.cookie);
    assert.equal(pageB.status, 404);
  });
});
