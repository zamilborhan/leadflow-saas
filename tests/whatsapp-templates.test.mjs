// WhatsApp message template tests.
//
// Two layers, matching the module boundaries:
//  1. Pure unit tests with a mocked Graph API (direct .ts imports work with
//     Node type-stripping; client.ts and template-parse.ts have no
//     project-local imports): template listing incl. cursor pagination,
//     variable extraction, preview rendering, sendable gating, error
//     mapping, token hygiene.
//  2. HTTP end-to-end against a dedicated production server (`next start`
//     on 8103 — a second `next dev` is blocked by Next's single-dev-server
//     lock, so this file builds once via `npm run build` then serves the
//     production bundle) with META_GRAPH_BASE_URL pointed at an in-test
//     mock Graph API on an ephemeral port. No fixed ports anywhere: fully
//     parallel-safe. Covers sync (upsert + prune), cached listing, lead
//     template selection lifecycle, gating, validation, encrypted storage,
//     and settings/lead-page UI isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";
import { MetaApiError, WhatsAppCloudClient } from "../src/lib/integrations/whatsapp/client.ts";
import {
  extractVariables,
  isSendableStatus,
  renderPreview,
} from "../src/lib/integrations/whatsapp/template-parse.ts";

const RUN_TAG = `wt${Date.now()}`;

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BODY_COMPONENT = {
  type: "BODY",
  text: "Hello {{1}}, your order {{order_id}} is ready.",
};

describe("WhatsAppCloudClient.listMessageTemplates (mocked)", () => {
  it("lists templates with the documented path and fields", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse({
        data: [
          {
            id: "T1",
            name: "order_update",
            language: "en_US",
            category: "UTILITY",
            status: "APPROVED",
            components: [BODY_COMPONENT, { type: "FOOTER", text: "Thanks" }],
          },
          { id: "T2", name: "broken" },
        ],
      })
    );
    const templates = await new WhatsAppCloudClient({ fetchImpl }).listMessageTemplates({
      wabaId: "WABA1",
      token: "SYS_TOKEN",
    });
    assert.equal(templates.length, 1, "malformed entries must be skipped");
    assert.deepEqual(templates[0], {
      id: "T1",
      name: "order_update",
      language: "en_US",
      category: "UTILITY",
      status: "APPROVED",
      components: [BODY_COMPONENT, { type: "FOOTER", text: "Thanks" }],
    });
    const url = new URL(calls[0].url);
    assert.ok(url.pathname.endsWith("/WABA1/message_templates"));
    assert.equal(url.searchParams.get("fields"), "id,name,language,category,status,components");
    assert.equal(url.searchParams.get("access_token"), null);
    assert.equal(calls[0].init?.headers?.Authorization, "Bearer SYS_TOKEN");
  });

  it("follows cursor pagination until the limit", async () => {
    const { calls, fetchImpl } = mockFetch((url) => {
      const u = new URL(url);
      if (!u.searchParams.get("after")) {
        return jsonResponse({
          data: [{ id: "T1", name: "a", language: "en_US", status: "APPROVED", components: [] }],
          paging: { cursors: { after: "CURSOR2" } },
        });
      }
      return jsonResponse({
        data: [{ id: "T2", name: "b", language: "en_US", status: "PENDING", components: [] }],
      });
    });
    const all = await new WhatsAppCloudClient({ fetchImpl }).listMessageTemplates({ wabaId: "W", token: "T" });
    assert.equal(all.length, 2);
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[1].url).searchParams.get("after"), "CURSOR2");
    const limited = await new WhatsAppCloudClient({ fetchImpl }).listMessageTemplates({
      wabaId: "W",
      token: "T",
      limit: 1,
    });
    assert.equal(limited.length, 1);
  });

  it("maps errors without leaking tokens", async () => {
    const secret = "SYS_never-in-errors";
    const failing = mockFetch(() =>
      jsonResponse({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }, 400)
    );
    await assert.rejects(
      new WhatsAppCloudClient({ fetchImpl: failing.fetchImpl }).listMessageTemplates({
        wabaId: "W",
        token: secret,
      }),
      (err) => {
        assert.ok(err instanceof MetaApiError);
        assert.equal(err.code, 190);
        assert.ok(!err.message.includes(secret));
        return true;
      }
    );
    const down = mockFetch(() => {
      throw new Error("socket hang up");
    });
    await assert.rejects(
      new WhatsAppCloudClient({ fetchImpl: down.fetchImpl }).listMessageTemplates({ wabaId: "W", token: secret }),
      (err) => {
        assert.ok(!String(err.message).includes(secret));
        return true;
      }
    );
  });
});

describe("template parsing + preview (pure)", () => {
  it("gates sending on APPROVED status only", () => {
    assert.equal(isSendableStatus("APPROVED"), true);
    for (const s of ["PENDING", "REJECTED", "PAUSED", "DISABLED", "IN_APPEAL", "", null, undefined]) {
      assert.equal(isSendableStatus(s), false);
    }
  });

  it("extracts positional and named variables in order", () => {
    assert.deepEqual(extractVariables([{ type: "BODY", text: "Hi {{1}}, order {{order_id}} ships {{2}}." }]), [
      { component: "BODY", key: "1", positional: true },
      { component: "BODY", key: "order_id", positional: false },
      { component: "BODY", key: "2", positional: true },
    ]);
    assert.deepEqual(extractVariables([{ type: "BODY", text: "No vars." }]), []);
    assert.deepEqual(extractVariables([{ type: "HEADER" }]), []);
    assert.deepEqual(extractVariables([null, 42, { type: 7, text: 7 }]), []);
  });

  it("renders previews with substitution, leaving unknowns intact", () => {
    const lines = renderPreview(
      [
        { type: "HEADER", text: "Order {{1}}" },
        { type: "BODY", text: "Hi {{name}}, code {{2}}." },
        { type: "FOOTER", text: "Bye" },
        { type: "BUTTONS" },
      ],
      { "1": "42", name: "Amena" }
    );
    assert.deepEqual(lines, [
      { component: "HEADER", text: "Order 42" },
      { component: "BODY", text: "Hi Amena, code {{2}}." },
      { component: "FOOTER", text: "Bye" },
    ]);
    assert.deepEqual(renderPreview([], {}), []);
  });
});

// ---------------------------------------------------------------------------
// HTTP end-to-end: dedicated prod server + in-test mock Graph API.
// ---------------------------------------------------------------------------

const ROOT = path.join(import.meta.dirname, "..");
const APP_PORT = 8103;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const PASSWORD = "correct horse battery staple 12";
let seq = 0;
let callNo = 0;

const testEmail = () => `${RUN_TAG}+${seq++}@example.invalid`;

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
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Mock Graph API for templates. Templates are mutable per test via
// mockTemplates (module state is fine here: one file, one process).
let mockTemplates = [];
function templateRow(name, language, status, bodyText) {
  return {
    id: `tpl-${name}-${language}-${RUN_TAG}`,
    name,
    language,
    category: "UTILITY",
    status,
    components: [{ type: "BODY", text: bodyText }],
  };
}

function defaultMockTemplates() {
  return [
    templateRow(`order_update_${RUN_TAG}`, "en_US", "APPROVED", "Hello {{1}}, your order {{order_id}} is ready."),
    templateRow(`order_update_${RUN_TAG}`, "bn_BD", "APPROVED", "Hello {{1}}."),
    templateRow(`promo_${RUN_TAG}`, "en_US", "PENDING", "Sale {{1}}!"),
    templateRow(`old_${RUN_TAG}`, "en_US", "REJECTED", "Old {{1}}."),
  ];
}

let mockServer = null;
let mockPort = 0;
let server = null;

before(async () => {
  mockTemplates = defaultMockTemplates();
  mockServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const send = (payload, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const tplMatch = url.pathname.match(/^\/v26\.0\/([A-Za-z0-9_.-]+)\/message_templates$/);
    if (req.method === "GET" && tplMatch) {
      const wabaId = tplMatch[1];
      if (wabaId.includes(".badtoken.")) {
        send({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }, 400);
        return;
      }
      send({ data: mockTemplates });
      return;
    }
    const phonesMatch = url.pathname.match(/^\/v26\.0\/([A-Za-z0-9_.-]+)\/phone_numbers$/);
    if (req.method === "GET" && phonesMatch) {
      const wabaId = phonesMatch[1];
      send({
        data: [
          { id: `${wabaId}-phone-1`, display_phone_number: "+1 555-0100", verified_name: `Acme ${RUN_TAG}` },
          { id: `${wabaId}-phone-2`, display_phone_number: "+1 555-0101", verified_name: `Acme ${RUN_TAG}` },
        ],
      });
      return;
    }
    const nodeMatch = url.pathname.match(/^\/v26\.0\/([A-Za-z0-9_.-]+)$/);
    if (req.method === "GET" && nodeMatch) {
      const nodeId = nodeMatch[1];
      if (nodeId.includes(".badtoken.")) {
        send({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }, 400);
        return;
      }
      if (nodeId.includes(".missing.")) {
        send({ error: { message: "(#100) Object does not exist.", type: "OAuthException", code: 100 } }, 404);
        return;
      }
      send({ id: nodeId, display_phone_number: "+1 555-0100", verified_name: `Acme ${RUN_TAG}` });
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
  server = spawn("node", ["node_modules/next/dist/bin/next", "start", "--port", String(APP_PORT)], {
    cwd: ROOT,
    stdio: "ignore",
    env: {
      ...process.env,
      ...dotEnv,
      META_GRAPH_BASE_URL: `http://127.0.0.1:${mockPort}/v26.0`,
    },
  });
  await waitForPort(APP_PORT, 120_000);
}, { timeout: 200_000 });

after(async () => {
  if (server) {
    server.kill();
    server = null;
  }
  if (mockServer) {
    await new Promise((resolve) => {
      try {
        mockServer.closeAllConnections();
      } catch {
        // Node <18.2 fallback: plain close below.
      }
      mockServer.close(() => resolve());
    });
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
      await client.query(`DELETE FROM "LeadTemplateSelection" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "LeadActivity" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "Lead" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "WhatsAppTemplate" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "WhatsAppConnection" WHERE "businessId" = ANY($1)`, [bizIds]);
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
  return r.json.business;
}

async function invite(cookie, businessId, email, role) {
  const r = await api("POST", `/api/businesses/${businessId}/members`, {
    body: { email, role },
    cookie,
  });
  assert.equal(r.status, 201, `invite ${role} failed: ${JSON.stringify(r.json)}`);
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

async function connectWhatsApp(cookie, businessId, suffix) {
  const wabaId = `waba-${RUN_TAG}-${suffix}`;
  const r = await api("POST", `/api/businesses/${businessId}/whatsapp/connect`, {
    body: { wabaId, phoneNumberId: `${wabaId}-phone-1`, accessToken: `SYS-token-${RUN_TAG}` },
    cookie,
  });
  assert.equal(r.status, 200, `connect failed: ${JSON.stringify(r.json)}`);
  return { wabaId };
}

async function createLead(cookie, businessId, name) {
  const r = await api("POST", `/api/businesses/${businessId}/leads`, {
    body: { name },
    cookie,
  });
  assert.equal(r.status, 201, `create lead failed: ${JSON.stringify(r.json)}`);
  return r.json.lead;
}

describe("whatsapp template sync + listing", () => {
  it("syncs Meta templates into a redacted cached catalog with prune", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} sync`);
    await connectWhatsApp(owner.cookie, biz.id, "sync");

    mockTemplates = defaultMockTemplates();
    const synced = await api("POST", `/api/businesses/${biz.id}/whatsapp/templates/sync`, { cookie: owner.cookie });
    assert.equal(synced.status, 200, `sync failed: ${JSON.stringify(synced.json)}`);
    assert.equal(synced.json.synced, 4);

    const listed = await api("GET", `/api/businesses/${biz.id}/whatsapp/templates`, { cookie: owner.cookie });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.templates.length, 4);
    const en = listed.json.templates.find((t) => t.name === `order_update_${RUN_TAG}` && t.language === "en_US");
    assert.ok(en);
    assert.equal(en.status, "APPROVED");
    assert.equal(en.sendable, true);
    assert.deepEqual(en.variables, [
      { component: "BODY", key: "1", positional: true },
      { component: "BODY", key: "order_id", positional: false },
    ]);
    assert.ok(en.components.some((c) => c.type === "BODY" && c.text.includes("{{1}}")));
    assert.ok(!JSON.stringify(listed.json).includes("SYS-token"), "token leaked in listing");

    // Same name in another language is a distinct row.
    const bn = listed.json.templates.find((t) => t.language === "bn_BD");
    assert.ok(bn);

    // Prune: Meta drops one template, sync removes it and keeps the rest.
    mockTemplates = defaultMockTemplates().slice(0, 3);
    const resync = await api("POST", `/api/businesses/${biz.id}/whatsapp/templates/sync`, { cookie: owner.cookie });
    assert.equal(resync.json.synced, 3);
    assert.equal(resync.json.pruned, 1);
    const rows = await dbRows(`SELECT COUNT(*)::int AS n FROM "WhatsAppTemplate" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(rows[0].n, 3);
    mockTemplates = defaultMockTemplates();
  });

  it("gates sync by session, membership, and manager role", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} gates`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    await connectWhatsApp(owner.cookie, biz.id, "gates");

    assert.equal((await api("POST", `/api/businesses/${biz.id}/whatsapp/templates/sync`)).status, 401);
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/whatsapp/templates/sync`, { cookie: sales.cookie })).status,
      403
    );
    const stranger = await registerAndLogin();
    await createBusiness(stranger.cookie, `${RUN_TAG} stranger`);
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/whatsapp/templates/sync`, { cookie: stranger.cookie })).status,
      403
    );
    assert.equal((await api("GET", `/api/businesses/${biz.id}/whatsapp/templates`, { cookie: stranger.cookie })).status, 403);
    // Members (incl. SALES) may list for the picker.
    assert.equal((await api("GET", `/api/businesses/${biz.id}/whatsapp/templates`, { cookie: sales.cookie })).status, 200);
    // Sync without a connection is 404, not 500.
    const fresh = await registerAndLogin();
    const freshBiz = await createBusiness(fresh.cookie, `${RUN_TAG} fresh`);
    assert.equal(
      (await api("POST", `/api/businesses/${freshBiz.id}/whatsapp/templates/sync`, { cookie: fresh.cookie })).status,
      404
    );
  });
});

describe("whatsapp lead template selection", () => {
  it("selects, reads, replaces, and clears an APPROVED template as SALES", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} select`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    await connectWhatsApp(owner.cookie, biz.id, "select");
    mockTemplates = defaultMockTemplates();
    await api("POST", `/api/businesses/${biz.id}/whatsapp/templates/sync`, { cookie: owner.cookie });
    const lead = await createLead(sales.cookie, biz.id, `${RUN_TAG} lead one`);

    const name = `order_update_${RUN_TAG}`;
    const selected = await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/template`, {
      body: { name, language: "en_US" },
      cookie: sales.cookie,
    });
    assert.equal(selected.status, 200, `select failed: ${JSON.stringify(selected.json)}`);
    assert.equal(selected.json.selection.templateName, name);
    assert.equal(selected.json.selection.status, "APPROVED");
    assert.ok(selected.json.selection.variables.length > 0);

    const fetched = await api("GET", `/api/businesses/${biz.id}/leads/${lead.id}/template`, { cookie: sales.cookie });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.selection.templateLanguage, "en_US");

    // Reselect replaces (still one row).
    const reselect = await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/template`, {
      body: { name, language: "bn_BD" },
      cookie: sales.cookie,
    });
    assert.equal(reselect.status, 200);
    assert.equal(reselect.json.selection.templateLanguage, "bn_BD");
    const rows = await dbRows(
      `SELECT COUNT(*)::int AS n FROM "LeadTemplateSelection" WHERE "businessId" = $1 AND "leadId" = $2`,
      [biz.id, lead.id]
    );
    assert.equal(rows[0].n, 1);

    // Clear lifecycle.
    assert.equal((await api("DELETE", `/api/businesses/${biz.id}/leads/${lead.id}/template`, { cookie: sales.cookie })).status, 200);
    assert.equal((await api("GET", `/api/businesses/${biz.id}/leads/${lead.id}/template`, { cookie: sales.cookie })).status, 404);
    assert.equal((await api("DELETE", `/api/businesses/${biz.id}/leads/${lead.id}/template`, { cookie: sales.cookie })).status, 404);
  });

  it("rejects unknown, unapproved, and invalid selections with tenant safety", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} select-neg`);
    await connectWhatsApp(owner.cookie, biz.id, "neg");
    mockTemplates = defaultMockTemplates();
    await api("POST", `/api/businesses/${biz.id}/whatsapp/templates/sync`, { cookie: owner.cookie });
    const lead = await createLead(owner.cookie, biz.id, `${RUN_TAG} lead neg`);

    // Unknown template.
    assert.equal(
      (
        await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/template`, {
          body: { name: "nope", language: "en_US" },
          cookie: owner.cookie,
        })
      ).status,
      404
    );
    // Known but PENDING.
    assert.equal(
      (
        await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/template`, {
          body: { name: `promo_${RUN_TAG}`, language: "en_US" },
          cookie: owner.cookie,
        })
      ).status,
      409
    );
    // Missing fields.
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/template`, { body: {}, cookie: owner.cookie }))
        .status,
      422
    );
    // Unknown + foreign leads are indistinguishable 404s.
    const { randomUUID } = await import("node:crypto");
    assert.equal(
      (await api("GET", `/api/businesses/${biz.id}/leads/${randomUUID()}/template`, { cookie: owner.cookie })).status,
      404
    );
    const stranger = await registerAndLogin();
    const strangerBiz = await createBusiness(stranger.cookie, `${RUN_TAG} neg-stranger`);
    assert.equal(
      (await api("GET", `/api/businesses/${strangerBiz.id}/leads/${lead.id}/template`, { cookie: stranger.cookie }))
        .status,
      404
    );
    assert.equal(
      (
        await api("POST", `/api/businesses/${strangerBiz.id}/leads/${lead.id}/template`, {
          body: { name: `order_update_${RUN_TAG}`, language: "en_US" },
          cookie: stranger.cookie,
        })
      ).status,
      404
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/leads/${lead.id}/template`, {
        body: { name: `order_update_${RUN_TAG}`, language: "en_US" },
      })).status,
      401
    );
  });
});

describe("whatsapp templates tenant isolation + UI", () => {
  it("keeps Business B blind to Business A's templates and selections", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} iso-A`);
    const bizB = await createBusiness(b.cookie, `${RUN_TAG} iso-B`);
    await connectWhatsApp(a.cookie, bizA.id, "isoA");
    mockTemplates = defaultMockTemplates();
    await api("POST", `/api/businesses/${bizA.id}/whatsapp/templates/sync`, { cookie: a.cookie });
    const leadA = await createLead(a.cookie, bizA.id, `${RUN_TAG} iso lead`);
    await api("POST", `/api/businesses/${bizA.id}/leads/${leadA.id}/template`, {
      body: { name: `order_update_${RUN_TAG}`, language: "en_US" },
      cookie: a.cookie,
    });

    // B's catalog is empty; A's rows are untouched.
    const listB = await api("GET", `/api/businesses/${bizB.id}/whatsapp/templates`, { cookie: b.cookie });
    assert.deepEqual(listB.json.templates, []);
    const rows = await dbRows(`SELECT COUNT(*)::int AS n FROM "WhatsAppTemplate" WHERE "businessId" = $1`, [bizA.id]);
    assert.equal(rows[0].n, 4);

    // Lead page renders the selection to A only.
    const pageA = await getHtml(`/dashboard/leads/${leadA.id}?businessId=${bizA.id}`, a.cookie);
    assert.equal(pageA.status, 200);
    assert.ok(pageA.html.includes(`order_update_${RUN_TAG}`), "template name missing for owner");
    assert.ok(pageA.html.includes("{{1}}"), "variables missing for owner");
    const pageB = await getHtml(`/dashboard/leads/${leadA.id}?businessId=${bizB.id}`, b.cookie);
    assert.equal(pageB.status, 404);

    // Integrations page lists templates to A only.
    const intA = await getHtml(`/dashboard/settings/integrations?businessId=${bizA.id}`, a.cookie);
    assert.equal(intA.status, 200);
    assert.ok(intA.html.includes("Message templates"), "templates card missing");
    assert.ok(intA.html.includes(`promo_${RUN_TAG}`), "pending template missing");
    const intB = await getHtml(`/dashboard/settings/integrations?businessId=${bizB.id}`, b.cookie);
    assert.equal(intB.status, 200);
    assert.ok(!intB.html.includes(`order_update_${RUN_TAG}`), "template name leaked cross-tenant");
  });
});
