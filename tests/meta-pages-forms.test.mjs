// Meta Pages + Lead Forms tests.
//
// Three layers, matching the module boundaries:
//  1. Pure unit tests with a mocked Graph API (direct .ts imports work with
//     Node type-stripping; client.ts has no project-local imports):
//     listPages / listLeadForms parsing, error mapping, token hygiene.
//  2. Pure unit tests of the selection rules (selection-rules.ts imports
//     only error classes + client types): page/form resolution, task
//     gating, ACTIVE enforcement, merge logic — the exact decision code the
//     service layer enforces.
//  3. HTTP tests against the dev server with DB-seeded rows (MetaConnection,
//     MetaPage, MetaForm): route auth/tenant gating, validation, redacted
//     selection, form disconnect, encrypted-at-rest storage, and settings UI
//     isolation. Paths that call Meta live (page/form listing, select,
//     connect) are covered at layers 1–2; HTTP asserts every reachable
//     pre-Meta behavior (401/403/404/409/422) on those routes.
//     The Graph API itself is never touched from HTTP tests.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";
import { decryptToken, encryptToken } from "../src/lib/integrations/meta/crypto.ts";
import { MetaApiError, MetaGraphClient } from "../src/lib/integrations/meta/client.ts";
import {
  pickConnectableForm,
  pickSelectablePage,
  pageSelectable,
  SelectionConflict,
  SelectionNotFound,
  toAvailableForms,
  toAvailablePages,
} from "../src/lib/integrations/meta/selection-rules.ts";

const RUN_TAG = `mpf${Date.now()}`;
const PAGE_1 = `page-1-${RUN_TAG}`;
const FORM_1 = `form-1-${RUN_TAG}`;
const PAGE_TOKEN_1 = `EAA-page-token-1-${RUN_TAG}`;

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

describe("MetaGraphClient pages + forms (mocked Graph API)", () => {
  it("lists pages with the documented fields and versioned path", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse({
        data: [
          { id: "P1", name: "Shop One", access_token: "PAGE_TOK", tasks: ["ADVERTISE", "MANAGE"] },
          { id: "P2", name: "Shop Two", tasks: ["ANALYZE"] },
          { id: 42, name: "Broken" },
        ],
      })
    );
    const pages = await new MetaGraphClient({ fetchImpl }).listPages("USER_TOKEN");
    assert.equal(pages.length, 2, "malformed entries must be skipped");
    assert.deepEqual(pages[0], { id: "P1", name: "Shop One", tasks: ["ADVERTISE", "MANAGE"], pageToken: "PAGE_TOK" });
    assert.equal(pages[1].pageToken, null);
    const url = new URL(calls[0].url);
    assert.ok(url.hostname === "graph.facebook.com");
    assert.ok(url.pathname.endsWith("/me/accounts"));
    assert.equal(url.searchParams.get("fields"), "id,name,access_token,tasks");
  });

  it("lists lead forms with status, defaulting unknown shapes safely", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse({
        data: [
          { id: "F1", name: "Winter Sale", status: "ACTIVE" },
          { id: "F2", name: "Old Promo", status: "ARCHIVED" },
          { id: "F3", name: "No Status" },
          { id: "F4" },
        ],
      })
    );
    const forms = await new MetaGraphClient({ fetchImpl }).listLeadForms({ pageId: "P1", pageToken: "PAGE_TOK" });
    assert.equal(forms.length, 3);
    assert.deepEqual(forms[0], { id: "F1", name: "Winter Sale", status: "ACTIVE" });
    assert.equal(forms[2].status, "UNKNOWN");
    const url = new URL(calls[0].url);
    assert.ok(url.pathname.endsWith("/P1/leadgen_forms"));
    assert.equal(url.searchParams.get("fields"), "id,name,status");
  });

  it("maps Meta errors without leaking tokens", async () => {
    const secret = "EAA-page-token-never-in-errors";
    const failing = mockFetch(() =>
      jsonResponse({ error: { message: "Unsupported get request.", type: "GraphMethodException", code: 100 } }, 400)
    );
    await assert.rejects(
      new MetaGraphClient({ fetchImpl: failing.fetchImpl }).listPages(secret),
      (err) => {
        assert.ok(err instanceof MetaApiError);
        assert.equal(err.message, "Unsupported get request.");
        assert.equal(err.code, 100);
        return true;
      }
    );
    const down = mockFetch(() => {
      throw new Error("socket hang up");
    });
    await assert.rejects(
      new MetaGraphClient({ fetchImpl: down.fetchImpl }).listLeadForms({ pageId: "P", pageToken: secret }),
      (err) => {
        assert.ok(!String(err.message).includes(secret));
        return true;
      }
    );
    const shape = mockFetch(() => jsonResponse({ data: { not: "a list" } }));
    await assert.rejects(
      new MetaGraphClient({ fetchImpl: shape.fetchImpl }).listLeadForms({ pageId: "P", pageToken: "T" }),
      MetaApiError
    );
  });
});

describe("selection rules (pure)", () => {
  const pages = [
    { id: "P1", name: "Shop One", tasks: ["ADVERTISE", "MANAGE"], pageToken: "TOK1" },
    { id: "P2", name: "Shop Two", tasks: ["ANALYZE"], pageToken: "TOK2" },
    { id: "P3", name: "Shop Three", tasks: ["ADVERTISE"], pageToken: null },
  ];

  it("gates page selection on tasks and token presence", () => {
    assert.ok(pageSelectable(["ADVERTISE"]));
    assert.ok(pageSelectable(["MANAGE"]));
    assert.ok(!pageSelectable(["ANALYZE"]));
    assert.ok(!pageSelectable([]));

    const picked = pickSelectablePage(pages, "P1");
    assert.equal(picked.id, "P1");
    assert.equal(picked.pageToken, "TOK1");
    assert.throws(() => pickSelectablePage(pages, "missing"), SelectionNotFound);
    assert.throws(() => pickSelectablePage(pages, "P2"), SelectionConflict);
    assert.throws(() => pickSelectablePage(pages, "P3"), SelectionConflict);
    assert.throws(() => pickSelectablePage(pages, ""), SelectionConflict);
  });

  it("gates form connection on existence and ACTIVE status", () => {
    const forms = [
      { id: "F1", name: "Winter", status: "ACTIVE" },
      { id: "F2", name: "Old", status: "ARCHIVED" },
    ];
    assert.equal(pickConnectableForm(forms, "F1").id, "F1");
    assert.throws(() => pickConnectableForm(forms, "missing"), SelectionNotFound);
    assert.throws(() => pickConnectableForm(forms, "F2"), SelectionConflict);
    assert.throws(() => pickConnectableForm(forms, ""), SelectionConflict);
  });

  it("merges live lists with persisted flags without token fields", () => {
    const listed = toAvailablePages(pages, new Set(["P2"]));
    assert.deepEqual(listed.find((p) => p.metaPageId === "P1"), {
      metaPageId: "P1",
      name: "Shop One",
      tasks: ["ADVERTISE", "MANAGE"],
      selectable: true,
      selected: false,
    });
    assert.equal(listed.find((p) => p.metaPageId === "P2").selected, true);
    assert.equal(listed.find((p) => p.metaPageId === "P2").selectable, false);
    assert.ok(!JSON.stringify(listed).includes("TOK1"), "page token leaked into available list");

    const forms = toAvailableForms(
      [
        { id: "F1", name: "Winter", status: "ACTIVE" },
        { id: "F2", name: "Old", status: "ARCHIVED" },
      ],
      new Set(["F1"])
    );
    assert.deepEqual(forms[0], { metaFormId: "F1", name: "Winter", status: "ACTIVE", connected: true });
    assert.equal(forms[1].connected, false);
  });
});

// ---------------------------------------------------------------------------
// HTTP tests against the dev server with DB-seeded rows.
// Live-Meta paths (page/form listing, select, connect) are covered by the
// unit layers above; here every reachable pre-Meta behavior is asserted.
// ---------------------------------------------------------------------------

const ROOT = path.join(import.meta.dirname, "..");
const FALLBACK_PORT = 8099;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
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
  return `10.90.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
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
      await client.query(`DELETE FROM "MetaForm" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "MetaPage" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "MetaConnection" WHERE "businessId" = ANY($1)`, [bizIds]);
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
  assert.ok(reg.json.businessId, "register must return the auto-created businessId");
  const login = await api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.ok(login.cookie);
  return { email, cookie: login.cookie, businessId: reg.json.businessId };
}

async function createBusiness(cookie, name, plan = "STARTER") {
  // Registration auto-creates the workspace (FREE quota); adopt it and set
  // the plan context the test needs. `name` is kept for call-site parity.
  void name;
  const list = await api("GET", "/api/businesses", { cookie });
  assert.equal(list.status, 200);
  assert.ok(list.json.businesses.length >= 1, "expected auto-created workspace");
  const biz = list.json.businesses[0];
  // Quota context: these tests invite a second member, which exceeds FREE.
  if (plan) {
    const s = await api("PATCH", `/api/businesses/${biz.id}/subscription`, {
      body: { planCode: plan },
      cookie,
    });
    assert.equal(s.status, 200, `set plan failed: ${JSON.stringify(s.json)}`);
  }
  return biz;
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

async function seedConnection(businessId) {
  const keyRaw = loadDotEnv().META_TOKEN_KEY;
  assert.ok(keyRaw, "META_TOKEN_KEY missing in .env");
  const ciphertext = await encryptToken(`EAA-seed-${RUN_TAG}`, keyRaw);
  const client = pg();
  await client.connect();
  try {
    const { randomUUID } = await import("node:crypto");
    await client.query(
      `INSERT INTO "MetaConnection"
        ("id", "businessId", "metaUserId", "metaUserName", "accessTokenEncrypted", "scopes", "status", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', NOW())`,
      [randomUUID(), businessId, `meta-user-${RUN_TAG}`, `Seed Owner ${RUN_TAG}`, ciphertext, "pages_show_list leads_retrieval"]
    );
  } finally {
    await client.end();
  }
}

async function seedPage(businessId, { metaPageId, name, selectedAt }) {
  const keyRaw = loadDotEnv().META_TOKEN_KEY;
  const ciphertext = await encryptToken(`EAA-page-${metaPageId}`, keyRaw);
  const client = pg();
  await client.connect();
  try {
    const { randomUUID } = await import("node:crypto");
    await client.query(
      `INSERT INTO "MetaPage"
        ("id", "businessId", "metaPageId", "name", "pageTokenEncrypted", "tasks", "selectedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [randomUUID(), businessId, metaPageId, name, ciphertext, "ADVERTISE MANAGE", selectedAt]
    );
  } finally {
    await client.end();
  }
}

async function seedForm(businessId, { metaPageId, metaFormId, name, status }) {
  const client = pg();
  await client.connect();
  try {
    const { randomUUID } = await import("node:crypto");
    await client.query(
      `INSERT INTO "MetaForm"
        ("id", "businessId", "metaPageId", "metaFormId", "name", "status", "connectedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
      [randomUUID(), businessId, metaPageId, metaFormId, name, status]
    );
  } finally {
    await client.end();
  }
}

describe("meta pages/forms routes", () => {
  it("gates every endpoint by session, membership, and manager role", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} gates`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    await seedConnection(biz.id);

    const stranger = await registerAndLogin();
    await createBusiness(stranger.cookie, `${RUN_TAG} stranger`);

    // Unauthenticated.
    assert.equal((await api("GET", `/api/businesses/${biz.id}/meta/pages`)).status, 401);
    assert.equal((await api("GET", `/api/businesses/${biz.id}/meta/selection`)).status, 401);
    // Cross-tenant.
    for (const [method, urlPath, body] of [
      ["GET", `/api/businesses/${biz.id}/meta/pages`, undefined],
      ["POST", `/api/businesses/${biz.id}/meta/pages/select`, { metaPageId: PAGE_1 }],
      ["GET", `/api/businesses/${biz.id}/meta/forms`, undefined],
      ["POST", `/api/businesses/${biz.id}/meta/forms/connect`, { metaFormId: FORM_1 }],
      ["DELETE", `/api/businesses/${biz.id}/meta/forms`, undefined],
      ["GET", `/api/businesses/${biz.id}/meta/selection`, undefined],
    ]) {
      const r = await api(method, urlPath, { body, cookie: stranger.cookie });
      assert.equal(r.status, 403, `${method} ${urlPath} -> ${r.status}`);
    }
    // SALES (members.read only) cannot manage pages/forms.
    for (const [method, urlPath, body] of [
      ["GET", `/api/businesses/${biz.id}/meta/pages`, undefined],
      ["POST", `/api/businesses/${biz.id}/meta/pages/select`, { metaPageId: PAGE_1 }],
      ["GET", `/api/businesses/${biz.id}/meta/forms`, undefined],
      ["POST", `/api/businesses/${biz.id}/meta/forms/connect`, { metaFormId: FORM_1 }],
      ["DELETE", `/api/businesses/${biz.id}/meta/forms`, undefined],
    ]) {
      const r = await api(method, urlPath, { body, cookie: sales.cookie });
      assert.equal(r.status, 403, `SALES ${method} ${urlPath} -> ${r.status}`);
    }
    // Selection reads are membership-gated (SALES allowed) and redacted.
    const sel = await api("GET", `/api/businesses/${biz.id}/meta/selection`, { cookie: sales.cookie });
    assert.equal(sel.status, 200);
    assert.deepEqual(sel.json, { page: null, form: null });
  });

  it("validates select/connect input and requires a selected page", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} validation`);
    await seedConnection(biz.id);

    // Empty ids rejected before any Meta call.
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/meta/pages/select`, { body: {}, cookie: owner.cookie })).status,
      422
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/meta/forms/connect`, { body: {}, cookie: owner.cookie })).status,
      422
    );
    // Forms require a selected page first (409, no Meta call).
    assert.equal((await api("GET", `/api/businesses/${biz.id}/meta/forms`, { cookie: owner.cookie })).status, 409);
    // Disconnect with nothing connected.
    assert.equal((await api("DELETE", `/api/businesses/${biz.id}/meta/forms`, { cookie: owner.cookie })).status, 404);
  });

  it("serves redacted selection, disconnects forms, and stores ciphertext", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} persisted`);
    await seedConnection(biz.id);
    const pageName = `Shop Persisted ${RUN_TAG}`;
    const formName = `Form Persisted ${RUN_TAG}`;
    await seedPage(biz.id, { metaPageId: PAGE_1, name: pageName, selectedAt: new Date().toISOString() });
    await seedForm(biz.id, { metaPageId: PAGE_1, metaFormId: FORM_1, name: formName, status: "ACTIVE" });

    // Selection reflects persisted rows with metadata only.
    const sel = await api("GET", `/api/businesses/${biz.id}/meta/selection`, { cookie: owner.cookie });
    assert.equal(sel.status, 200);
    assert.equal(sel.json.page.metaPageId, PAGE_1);
    assert.equal(sel.json.page.name, pageName);
    assert.ok(sel.json.page.selectedAt);
    assert.equal(sel.json.form.metaFormId, FORM_1);
    assert.equal(sel.json.form.metaPageId, PAGE_1);
    assert.equal(sel.json.form.name, formName);
    assert.equal(sel.json.form.status, "ACTIVE");
    assert.ok(sel.json.form.connectedAt);
    const serialized = JSON.stringify(sel.json);
    assert.ok(!serialized.includes(PAGE_TOKEN_1), "page token leaked in selection");
    assert.ok(!serialized.includes("pageToken"), "token field leaked in selection");
    assert.ok(!serialized.includes("accessToken"), "token field leaked in selection");

    // Page tokens rest encrypted; round-trip through the server key.
    const keyRaw = loadDotEnv().META_TOKEN_KEY;
    const rows = await dbRows(`SELECT "pageTokenEncrypted" FROM "MetaPage" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].pageTokenEncrypted.startsWith("v1."));
    assert.equal(await decryptToken(rows[0].pageTokenEncrypted, keyRaw), `EAA-page-${PAGE_1}`);

    // Disconnect removes the form row; selection clears; repeat is 404.
    assert.equal((await api("DELETE", `/api/businesses/${biz.id}/meta/forms`, { cookie: owner.cookie })).status, 200);
    const after = await api("GET", `/api/businesses/${biz.id}/meta/selection`, { cookie: owner.cookie });
    assert.equal(after.json.form, null);
    assert.equal(after.json.page.metaPageId, PAGE_1);
    assert.equal((await api("DELETE", `/api/businesses/${biz.id}/meta/forms`, { cookie: owner.cookie })).status, 404);
  });
});

describe("meta pages/forms tenant isolation + UI", () => {
  it("keeps Business B blind to Business A's pages and forms", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} iso-A`);
    const bizB = await createBusiness(b.cookie, `${RUN_TAG} iso-B`);
    await seedConnection(bizA.id);
    const pageName = `Shop Isolated ${RUN_TAG}`;
    const formName = `Form Isolated ${RUN_TAG}`;
    await seedPage(bizA.id, { metaPageId: PAGE_1, name: pageName, selectedAt: new Date().toISOString() });
    await seedForm(bizA.id, { metaPageId: PAGE_1, metaFormId: FORM_1, name: formName, status: "ACTIVE" });

    // B's own selection is empty; A's rows are untouched.
    const selB = await api("GET", `/api/businesses/${bizB.id}/meta/selection`, { cookie: b.cookie });
    assert.deepEqual(selB.json, { page: null, form: null });
    const selA = await api("GET", `/api/businesses/${bizA.id}/meta/selection`, { cookie: a.cookie });
    assert.equal(selA.json.page.metaPageId, PAGE_1);
    assert.equal(selA.json.form.metaFormId, FORM_1);

    // Settings UI renders names/dates to A only.
    const pageA = await getHtml(`/dashboard/settings/integrations?businessId=${bizA.id}`, a.cookie);
    assert.equal(pageA.status, 200);
    assert.ok(pageA.html.includes(pageName), "page name missing for owner");
    assert.ok(pageA.html.includes(formName), "form name missing for owner");
    assert.ok(pageA.html.includes("Reconnect"), "reconnect action missing");
    assert.ok(pageA.html.includes("Connected date"), "connected date missing");
    const pageB = await getHtml(`/dashboard/settings/integrations?businessId=${bizB.id}`, b.cookie);
    assert.equal(pageB.status, 200);
    assert.ok(!pageB.html.includes(pageName), "page name leaked cross-tenant");
    assert.ok(!pageB.html.includes(formName), "form name leaked cross-tenant");
    assert.ok(!pageB.html.includes(PAGE_1), "page id leaked cross-tenant");
    assert.ok(!pageB.html.includes(FORM_1), "form id leaked cross-tenant");
    assert.ok(!pageB.html.includes(PAGE_TOKEN_1), "page token in HTML");
  });
});
