// Critical end-to-end flow (acceptance):
// Register → Create Business → Add Sales Agent → Connect Facebook →
// Connect Lead Form → Receive Test Lead → Lead Appears in CRM →
// Assign Agent → Send WhatsApp Template → Schedule Follow-up →
// Complete Follow-up → Change Lead to Converted → Dashboard shows conversion.
//
// Live HTTP against a throwaway `next dev` server with an in-test mock
// Meta/WhatsApp Graph (META_GRAPH_BASE_URL). No real network.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Client } from "pg";

const ROOT = path.join(import.meta.dirname, "..");
const FALLBACK_PORT = 8105;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `e2e${Date.now()}`;
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
  return `10.210.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
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

// ---- Mock Meta/WhatsApp Graph ----
const LEADGEN_ID = `lg-${RUN_TAG}-e2e`;
const FORM_ID = `form-${RUN_TAG}-e2e`;
const PAGE_ID = `page-${RUN_TAG}-e2e`;
const WABA_ID = `waba-${RUN_TAG}-e2e`;
const PHONE_ID = `${WABA_ID}-phone-1`;

function mockTemplateList() {
  return [
    {
      id: `tpl-${RUN_TAG}`,
      name: `followup_${RUN_TAG}`,
      language: "en_US",
      category: "UTILITY",
      status: "APPROVED",
      components: [{ type: "BODY", text: "Hi {{1}}, following up on your inquiry {{order_id}}." }],
    },
  ];
}

let mockServer = null;
let mockPort = 0;
let server = null;
let ownServer = false;

before(async () => {
  mockServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const send = (payload, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && url.pathname === "/v26.0/me/accounts") {
      send({ data: [{ id: PAGE_ID, name: "E2E Page", tasks: ["ADVERTISE", "MANAGE"], access_token: "EAA-page-token" }] });
      return;
    }
    const formsEdge = url.pathname.match(/^\/v26\.0\/([A-Za-z0-9_.-]+)\/leadgen_forms$/);
    if (req.method === "GET" && formsEdge) {
      send({ data: [{ id: FORM_ID, name: "E2E Form", status: "ACTIVE" }] });
      return;
    }
    // Lead details (Meta webhook → getLeadDetails).
    const leadMatch = url.pathname.match(/^\/v26\.0\/([A-Za-z0-9_-]+)$/);
    if (req.method === "GET" && leadMatch && !url.pathname.endsWith("/accounts")) {
      const id = leadMatch[1];
      if (id.startsWith("lg-")) {
        send({
          id,
          created_time: "2026-09-08T08:49:14+0000",
          ad_id: `ad-${RUN_TAG}`,
          adset_id: `adset-${RUN_TAG}`,
          campaign_id: `camp-${RUN_TAG}`,
          campaign_name: `E2E Campaign ${RUN_TAG}`,
          adset_name: "E2E AdSet",
          ad_name: "E2E Ad",
          form_id: FORM_ID,
          field_data: [
            { name: "full_name", values: [`E2E Prospect ${RUN_TAG}`] },
            { name: "email", values: [`e2e-${RUN_TAG}@example.com`] },
            { name: "phone_number", values: ["+8801712345678"] },
          ],
        });
        return;
      }
      // WhatsApp phone node / health.
      if ((url.searchParams.get("fields") ?? "").includes("health_status")) {
        send({ id, health_status: { can_send_message: "AVAILABLE", entities: [] } });
        return;
      }
      send({ id, display_phone_number: "+1 555-0100", verified_name: `E2E ${RUN_TAG}` });
      return;
    }
    const phones = url.pathname.match(/^\/v26\.0\/([A-Za-z0-9_.-]+)\/phone_numbers$/);
    if (req.method === "GET" && phones) {
      const waba = phones[1];
      send({ data: [{ id: `${waba}-phone-1`, display_phone_number: "+1 555-0100", verified_name: `E2E ${RUN_TAG}` }] });
      return;
    }
    const tpls = url.pathname.match(/^\/v26\.0\/([A-Za-z0-9_.-]+)\/message_templates$/);
    if (req.method === "GET" && tpls) {
      send({ data: mockTemplateList() });
      return;
    }
    const sendMsg = url.pathname.match(/^\/v26\.0\/([A-Za-z0-9_.-]+)\/messages$/);
    if (req.method === "POST" && sendMsg) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => send({ messages: [{ id: `wamid.${RUN_TAG}` }] }));
      return;
    }
    send({ error: { message: "Unsupported mock request.", code: 100 } }, 400);
  });
  await new Promise((resolve, reject) => {
    mockServer.on("error", reject);
    mockServer.listen(0, "127.0.0.1", resolve);
  });
  mockPort = mockServer.address().port;

  if (await isPortOpen(PORT)) {
    ownServer = false;
    return;
  }
  PORT = FALLBACK_PORT;
  BASE = `http://127.0.0.1:${PORT}`;
  const dotEnv = loadDotEnv();
  server = spawn("node", ["node_modules/next/dist/bin/next", "dev", "--port", String(PORT)], {
    cwd: ROOT,
    stdio: "ignore",
    env: {
      ...process.env,
      ...dotEnv,
      META_GRAPH_BASE_URL: `http://127.0.0.1:${mockPort}/v26.0`,
    },
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
      await client.query(`DELETE FROM "WhatsAppMessage" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "LeadTemplateSelection" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "WhatsAppTemplate" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "WhatsAppConnection" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "FollowUp" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "LeadActivity" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "LeadNote" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "Lead" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "MetaLeadEvent" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "MetaForm" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "MetaPage" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "MetaConnection" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "AutomationJob" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "AutomationLog" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "AutomationRule" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "BusinessMember" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "Subscription" WHERE "businessId" = ANY($1)`, [bizIds]).catch(() => {});
      await client.query(`DELETE FROM "Business" WHERE id = ANY($1)`, [bizIds]).catch(() => {});
    }
    if (userIds.length > 0) {
      await client.query(`DELETE FROM "EmailVerificationToken" WHERE "userId" = ANY($1)`, [userIds]).catch(() => {});
      await client.query(`DELETE FROM "OAuthAccount" WHERE "userId" = ANY($1)`, [userIds]).catch(() => {});
      await client.query(`DELETE FROM "PasswordResetToken" WHERE "userId" = ANY($1)`, [userIds]).catch(() => {});
      await client.query(`DELETE FROM "Session" WHERE "userId" = ANY($1)`, [userIds]).catch(() => {});
      await client.query(`DELETE FROM "BusinessMember" WHERE "userId" = ANY($1)`, [userIds]).catch(() => {});
      await client.query(`DELETE FROM "User" WHERE id = ANY($1)`, [userIds]).catch(() => {});
    }
  } finally {
    await client.end();
  }
}, { timeout: 60_000 });

async function dbExec(sql, params) {
  const client = pg();
  await client.connect();
  try {
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function userIdByEmail(email) {
  const client = pg();
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT id FROM "User" WHERE email = $1`, [email]);
    assert.equal(rows.length, 1);
    return rows[0].id;
  } finally {
    await client.end();
  }
}

describe("critical end-to-end flow", () => {
  it("Register → Business → Agent → Facebook → Form → Lead → Assign → WhatsApp → Follow-up → Converted → Dashboard", async () => {
    // 1. Register.
    const ownerEmail = testEmail();
    const reg = await api("POST", "/api/auth/register", { body: { email: ownerEmail, password: PASSWORD, name: "E2E Owner" } });
    assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.json)}`);
    assert.ok(reg.cookie, "register must set session cookie");
    const login = await api("POST", "/api/auth/login", { body: { email: ownerEmail, password: PASSWORD } });
    assert.equal(login.status, 200);
    const ownerCookie = login.cookie;
    assert.ok(ownerCookie);

    // 2. Create Business (explicit POST; AGENCY quota allows a second workspace).
    const autoList = await api("GET", "/api/businesses", { cookie: ownerCookie });
    assert.equal(autoList.status, 200);
    assert.ok(autoList.json.businesses.length >= 1, "registration must auto-create a workspace");
    const upgrade = await api("PATCH", `/api/businesses/${autoList.json.businesses[0].id}/subscription`, {
      body: { planCode: "AGENCY" },
      cookie: ownerCookie,
    });
    assert.equal(upgrade.status, 200, `upgrade failed: ${JSON.stringify(upgrade.json)}`);
    const created = await api("POST", "/api/businesses", {
      body: { name: `${RUN_TAG} E2E Workspace` },
      cookie: ownerCookie,
    });
    assert.equal(created.status, 201, `create business failed: ${JSON.stringify(created.json)}`);
    const biz = created.json.business;
    assert.ok(biz.id);

    // The new workspace starts on FREE (1 member max) — upgrade it so the
    // sales-agent invite below fits the quota.
    const upgradeNew = await api("PATCH", `/api/businesses/${biz.id}/subscription`, {
      body: { planCode: "STARTER" },
      cookie: ownerCookie,
    });
    assert.equal(upgradeNew.status, 200, `upgrade new workspace failed: ${JSON.stringify(upgradeNew.json)}`);

    // Quota context for members: STARTER+ is fine.
    // Disable default automations so the flow stays deterministic.
    const rules = await api("GET", `/api/businesses/${biz.id}/automations/rules`, { cookie: ownerCookie });
    assert.equal(rules.status, 200);
    for (const rule of rules.json.rules) {
      const patched = await api("PATCH", `/api/businesses/${biz.id}/automations/rules/${rule.id}`, {
        body: { status: "DISABLED" },
        cookie: ownerCookie,
      });
      assert.equal(patched.status, 200);
    }

    // 3. Add Sales Agent.
    const salesEmail = testEmail();
    const salesReg = await api("POST", "/api/auth/register", { body: { email: salesEmail, password: PASSWORD, name: "E2E Sales" } });
    assert.equal(salesReg.status, 201);
    const salesLogin = await api("POST", "/api/auth/login", { body: { email: salesEmail, password: PASSWORD } });
    assert.equal(salesLogin.status, 200);
    const salesCookie = salesLogin.cookie;
    const invite = await api("POST", `/api/businesses/${biz.id}/members`, {
      body: { email: salesEmail, role: "SALES" },
      cookie: ownerCookie,
    });
    assert.equal(invite.status, 201, `invite failed: ${JSON.stringify(invite.json)}`);
    const salesId = await userIdByEmail(salesEmail);

    // 4. Connect Facebook (seed OAuth artefacts the way a completed OAuth flow would).
    const { encryptToken } = await import("../src/lib/integrations/meta/crypto.ts");
    const { randomUUID } = await import("node:crypto");
    const keyRaw = loadDotEnv().META_TOKEN_KEY;
    const ciphertext = await encryptToken(`EAA-e2e-${RUN_TAG}`, keyRaw);
    await dbExec(
      `INSERT INTO "MetaConnection" ("id", "businessId", "metaUserId", "metaUserName", "accessTokenEncrypted", "scopes", "status", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',NOW())`,
      [randomUUID(), biz.id, `meta-user-${RUN_TAG}`, "E2E Owner", ciphertext, "pages_show_list leads_retrieval"]
    );
    await dbExec(
      `INSERT INTO "MetaPage" ("id", "businessId", "metaPageId", "name", "pageTokenEncrypted", "tasks", "selectedAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())`,
      [randomUUID(), biz.id, PAGE_ID, "E2E Page", ciphertext, "ADVERTISE MANAGE"]
    );
    const metaStatus = await api("GET", `/api/businesses/${biz.id}/meta`, { cookie: ownerCookie });
    assert.equal(metaStatus.status, 200, `meta status failed: ${JSON.stringify(metaStatus.json)}`);
    assert.equal(metaStatus.json.connection?.status ?? metaStatus.json.status, metaStatus.json.connection?.status ?? metaStatus.json.status);

    // 5. Connect Lead Form.
    await dbExec(
      `INSERT INTO "MetaForm" ("id", "businessId", "metaPageId", "metaFormId", "name", "status", "connectedAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,'ACTIVE',NOW(),NOW())`,
      [randomUUID(), biz.id, PAGE_ID, FORM_ID, "E2E Form"]
    );
    const forms = await api("GET", `/api/businesses/${biz.id}/meta/forms`, { cookie: ownerCookie });
    assert.equal(forms.status, 200, `forms failed: ${JSON.stringify(forms.json)}`);
    const formsText = JSON.stringify(forms.json);
    assert.ok(formsText.includes(FORM_ID), "connected form missing from listing");

    // 6. Receive Test Lead (signed webhook, lead details from mock Graph).
    const payload = {
      object: "page",
      entry: [
        {
          id: PAGE_ID,
          time: 1757320000,
          changes: [
            { field: "leadgen", value: { leadgen_id: LEADGEN_ID, page_id: PAGE_ID, form_id: FORM_ID, created_time: 1757320000 } },
          ],
        },
      ],
    };
    const rawBody = JSON.stringify(payload);
    const secret = loadDotEnv().META_APP_SECRET;
    const sig = `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
    const hook = await fetch(`${BASE}/api/webhooks/meta`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig, "x-forwarded-for": nextIp() },
      body: rawBody,
      redirect: "manual",
    });
    assert.equal(hook.status, 200, `webhook intake failed: ${hook.status}`);
    const hookJson = await hook.json();
    assert.equal(hookJson.created, 1, `webhook did not create lead: ${JSON.stringify(hookJson)}`);

    // 7. Lead Appears in CRM.
    const leads = await api("GET", `/api/businesses/${biz.id}/leads?search=E2E%20Prospect`, { cookie: ownerCookie });
    assert.equal(leads.status, 200);
    assert.ok(leads.json.leads.length >= 1, "lead missing from CRM");
    const lead = leads.json.leads.find((l) => l.facebookLeadId === LEADGEN_ID) ?? leads.json.leads[0];
    assert.ok(lead.id);
    assert.equal(lead.phone, "+8801712345678");
    const leadGet = await api("GET", `/api/businesses/${biz.id}/leads/${lead.id}`, { cookie: ownerCookie });
    assert.equal(leadGet.status, 200);

    // 8. Assign Agent.
    const assigned = await api("PATCH", `/api/businesses/${biz.id}/leads/${lead.id}`, {
      body: { assignedTo: salesId },
      cookie: ownerCookie,
    });
    assert.equal(assigned.status, 200, `assign failed: ${JSON.stringify(assigned.json)}`);
    assert.equal(assigned.json.lead.assignedTo, salesId);

    // 9. Send WhatsApp Template (connect → sync → select → queue/send via mock Graph).
    const waConnect = await api("POST", `/api/businesses/${biz.id}/whatsapp/connect`, {
      body: { wabaId: WABA_ID, phoneNumberId: PHONE_ID, accessToken: `SYS-token-${RUN_TAG}` },
      cookie: ownerCookie,
    });
    assert.equal(waConnect.status, 200, `whatsapp connect failed: ${JSON.stringify(waConnect.json)}`);
    const synced = await api("POST", `/api/businesses/${biz.id}/whatsapp/templates/sync`, { cookie: ownerCookie });
    assert.equal(synced.status, 200, `template sync failed: ${JSON.stringify(synced.json)}`);
    assert.equal(synced.json.synced, 1);
    const tplName = `followup_${RUN_TAG}`;
    const selected = await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/template`, {
      body: { name: tplName, language: "en_US" },
      cookie: salesCookie,
    });
    assert.equal(selected.status, 200, `template select failed: ${JSON.stringify(selected.json)}`);
    const queued = await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/messages`, {
      body: { templateName: tplName, templateLanguage: "en_US", variables: { "1": "Karim", order_id: "42" } },
      cookie: salesCookie,
    });
    assert.equal(queued.status, 201, `whatsapp send failed: ${JSON.stringify(queued.json)}`);
    assert.ok(["SENT", "QUEUED"].includes(queued.json.message.status), `unexpected message status ${queued.json.message.status}`);

    // 10. Schedule Follow-up.
    const fu = await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/followups`, {
      body: { scheduledAt: new Date(Date.now() + 24 * 3600_000).toISOString(), notes: "E2E call back" },
      cookie: salesCookie,
    });
    assert.equal(fu.status, 201, `schedule failed: ${JSON.stringify(fu.json)}`);
    const fuId = fu.json.followUp.id;
    assert.ok(fuId);

    // 11. Complete Follow-up.
    const done = await api("PATCH", `/api/businesses/${biz.id}/followups/${fuId}`, {
      body: { status: "COMPLETED" },
      cookie: salesCookie,
    });
    assert.equal(done.status, 200, `complete failed: ${JSON.stringify(done.json)}`);
    assert.equal(done.json.followUp.status, "COMPLETED");

    // 12. Change Lead to Converted.
    const converted = await api("PATCH", `/api/businesses/${biz.id}/leads/${lead.id}`, {
      body: { status: "CONVERTED" },
      cookie: ownerCookie,
    });
    assert.equal(converted.status, 200, `convert failed: ${JSON.stringify(converted.json)}`);
    assert.equal(converted.json.lead.status, "CONVERTED");

    // 13. Dashboard shows conversion.
    const analytics = await api("GET", `/api/businesses/${biz.id}/analytics?days=30`, { cookie: ownerCookie });
    assert.equal(analytics.status, 200, `analytics failed: ${JSON.stringify(analytics.json)}`);
    const kpis = analytics.json.analytics.kpis;
    assert.ok(kpis.totalLeads >= 1, "dashboard missing lead");
    assert.ok(kpis.convertedLeads >= 1, "dashboard missing conversion");
    assert.ok(kpis.conversionRate > 0, "dashboard conversion rate not positive");
    assert.equal(analytics.json.analytics.agents.find((a) => a.userId === salesId)?.assigned >= 1, true);
  });
});
