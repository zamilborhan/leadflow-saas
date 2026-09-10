// Meta Lead Ads webhook tests.
//
// Layers, matching the module boundaries (direct .ts imports work with
// Node type-stripping; these modules have no project-local imports):
//  1. webhook-verify: handshake + HMAC signature validation.
//  2. webhook-parse: leadgen batch extraction + shape tolerance.
//  3. field-map: Meta field_data → CRM lead input mapping.
//  4. MetaGraphClient.getLeadDetails with a mocked Graph API.
//  5. isRetryableError classification (imported from webhook.ts? No —
//     webhook.ts is db-bound, so retryability is tested through HTTP
//     behavior instead: transient failure → FAILED+nextRetryAt, redelivery
//     after backoff → DONE exactly once).
//  6. HTTP end-to-end against a dedicated dev server (own port + env, so
//     the shared server is untouched) with META_GRAPH_BASE_URL pointed at
//     an in-test mock Graph API. Covers every acceptance criterion:
//     verification handshake, event → CRM lead, duplicate suppression,
//     safe retry, invalid rejection, tenant isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";
import {
  parseSignatureHeader,
  verifyHandshake,
  verifyWebhookSignature,
} from "../src/lib/integrations/meta/webhook-verify.ts";
import { extractLeadgenEvents, isLeadgenDelivery } from "../src/lib/integrations/meta/webhook-parse.ts";
import { mapLeadFields, normalizeFieldData } from "../src/lib/integrations/meta/field-map.ts";
import { MetaApiError, MetaGraphClient } from "../src/lib/integrations/meta/client.ts";

const APP_SECRET = "test-app-secret-for-hmac";
const VERIFY_TOKEN = "test-verify-token";

function signBody(rawBody, secret = APP_SECRET) {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

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

describe("webhook verification handshake", () => {
  it("echoes the challenge only for a valid subscribe handshake", async () => {
    assert.equal(verifyHandshake("subscribe", VERIFY_TOKEN, "CHALLENGE-1", VERIFY_TOKEN), "CHALLENGE-1");
    assert.equal(verifyHandshake("unsubscribe", VERIFY_TOKEN, "CHALLENGE-1", VERIFY_TOKEN), null);
    assert.equal(verifyHandshake("subscribe", "wrong-token", "CHALLENGE-1", VERIFY_TOKEN), null);
    assert.equal(verifyHandshake("subscribe", VERIFY_TOKEN, null, VERIFY_TOKEN), null);
    assert.equal(verifyHandshake("subscribe", null, "CHALLENGE-1", VERIFY_TOKEN), null);
    assert.equal(verifyHandshake(null, VERIFY_TOKEN, "CHALLENGE-1", VERIFY_TOKEN), null);
    // Challenge is echoed verbatim (Meta requires the exact value back).
    assert.equal(verifyHandshake("subscribe", VERIFY_TOKEN, "abc-123_xyz", VERIFY_TOKEN), "abc-123_xyz");
  });
});

describe("webhook signature validation", () => {
  it("accepts a correct HMAC over the raw body", async () => {
    const raw = '{"object":"page","entry":[]}';
    assert.equal(await verifyWebhookSignature(raw, signBody(raw), APP_SECRET), true);
  });

  it("rejects missing, malformed, and tampered signatures without throwing", async () => {
    const raw = '{"object":"page"}';
    const good = signBody(raw);
    assert.equal(await verifyWebhookSignature(raw, null, APP_SECRET), false);
    assert.equal(await verifyWebhookSignature(raw, "", APP_SECRET), false);
    assert.equal(await verifyWebhookSignature(raw, "sha256=zzzz", APP_SECRET), false);
    assert.equal(await verifyWebhookSignature(raw, "Bearer abc", APP_SECRET), false);
    assert.equal(await verifyWebhookSignature(raw, good, "wrong-secret"), false);
    assert.equal(await verifyWebhookSignature(`${raw} `, good, APP_SECRET), false);
    assert.equal(await verifyWebhookSignature(raw, good, ""), false);
    const tampered = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    assert.equal(await verifyWebhookSignature(raw, tampered, APP_SECRET), false);
  });

  it("parses only well-formed signature headers", async () => {
    const raw = "x";
    const sig = signBody(raw);
    assert.ok(parseSignatureHeader(sig) instanceof Uint8Array);
    assert.equal(parseSignatureHeader(sig)?.length, 32);
    assert.equal(parseSignatureHeader(null), null);
    assert.equal(parseSignatureHeader("sha256=xyz"), null);
    assert.equal(parseSignatureHeader("sha256="), null);
  });
});

function docPayload(overrides = {}) {
  return {
    object: "page",
    entry: [
      {
        id: "123123123",
        time: 1438292065,
        changes: [
          {
            field: "leadgen",
            value: {
              leadgen_id: "123123123123",
              page_id: "123123123",
              form_id: "12312312312",
              adgroup_id: "12312312312",
              ad_id: "12312312312",
              created_time: 1440120384,
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("leadgen payload extraction", () => {
  it("extracts the documented sample shape", () => {
    const events = extractLeadgenEvents(docPayload());
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      leadgenId: "123123123123",
      pageId: "123123123",
      formId: "12312312312",
      adId: "12312312312",
      adgroupId: "12312312312",
      createdTime: 1440120384,
    });
  });

  it("collects batched entries, ignores non-leadgen fields, skips malformed values", () => {
    const payload = {
      object: "page",
      entry: [
        {
          id: "1",
          time: 1,
          changes: [
            { field: "leadgen", value: { leadgen_id: "A", page_id: "P", form_id: "F" } },
            { field: "feed", value: { verb: "add" } },
            { field: "leadgen", value: { leadgen_id: "B", page_id: "P" } },
            { field: "leadgen", value: "not-an-object" },
            { field: "leadgen", value: { leadgen_id: "", page_id: "P", form_id: "F" } },
            null,
          ],
        },
        { id: "2", time: 2, changes: "not-an-array" },
        null,
        { id: "3", time: 3 },
      ],
    };
    const events = extractLeadgenEvents(payload);
    assert.equal(events.length, 1);
    assert.equal(events[0].leadgenId, "A");
    assert.equal(events[0].adId, null);
    assert.equal(events[0].createdTime, null);
  });

  it("accepts numeric ids and rejects non-page payloads", () => {
    assert.equal(
      extractLeadgenEvents({
        object: "page",
        entry: [{ id: 1, time: 1, changes: [{ field: "leadgen", value: { leadgen_id: 99, page_id: 7, form_id: 8 } }] }],
      })[0].leadgenId,
      "99"
    );
    assert.deepEqual(extractLeadgenEvents({ object: "user", entry: [] }), []);
    assert.deepEqual(extractLeadgenEvents(null), []);
    assert.deepEqual(extractLeadgenEvents("string"), []);
    assert.deepEqual(extractLeadgenEvents({ object: "page" }), []);
    assert.ok(isLeadgenDelivery(docPayload()));
    assert.ok(!isLeadgenDelivery({ object: "user", entry: [] }));
  });
});

describe("lead field mapping", () => {
  it("maps standard question keys", () => {
    assert.deepEqual(
      mapLeadFields([
        { name: "full_name", values: ["  Joe Example "] },
        { name: "email", values: ["JOE@EXAMPLE.COM"] },
        { name: "phone_number", values: ["+8801712345678"] },
      ]),
      { name: "Joe Example", email: "joe@example.com", phone: "+8801712345678" }
    );
  });

  it("joins first/last names and falls back safely", () => {
    assert.equal(mapLeadFields([{ name: "first_name", values: ["Amena"] }, { name: "last_name", values: ["Begum"] }]).name, "Amena Begum");
    assert.equal(mapLeadFields([{ name: "last_name", values: ["Begum"] }]).name, "Begum");
    assert.equal(mapLeadFields([]).name, "Facebook Lead");
    assert.equal(mapLeadFields([{ name: "custom_q", values: ["x"] }]).name, "Facebook Lead");
    // Case-insensitive keys, first non-empty value wins.
    assert.equal(
      mapLeadFields([{ name: "EMAIL", values: ["", "  TeSt@X.Co  "] }]).email,
      "test@x.co"
    );
  });

  it("drops invalid emails and clamps lengths instead of failing", () => {
    const mapped = mapLeadFields([
      { name: "full_name", values: ["N"] },
      { name: "email", values: ["not-an-email"] },
      { name: "phone", values: ["1".repeat(100)] },
    ]);
    assert.equal(mapped.email, undefined);
    assert.equal(mapped.phone?.length, 40);
    assert.equal(mapLeadFields([{ name: "full_name", values: [`x${"y".repeat(500)}`] }]).name.length, 200);
  });

  it("tolerates junk entries in field_data", () => {
    assert.deepEqual(normalizeFieldData("nope"), []);
    assert.deepEqual(normalizeFieldData([{ nope: 1 }, null, 42]), [{ name: undefined, values: [] }].filter((d) => d.name !== undefined));
    assert.deepEqual(mapLeadFields([{ name: "email", values: [42, null, "a@b.co"] }]).email, "a@b.co");
  });
});

describe("MetaGraphClient.getLeadDetails (mocked)", () => {
  const detailsPayload = {
    id: "LG123",
    created_time: "2026-09-08T08:49:14+0000",
    ad_id: "AD1",
    adset_id: "ADS1",
    campaign_id: "C1",
    campaign_name: "Winter Sale",
    adset_name: "Dhaka Broad",
    ad_name: "Creative A",
    form_id: "F1",
    field_data: [
      { name: "full_name", values: ["Joe Example"] },
      { name: "email", values: ["joe@example.com"] },
    ],
  };

  it("fetches by leadgen id with the documented fields", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse(detailsPayload));
    const details = await new MetaGraphClient({ fetchImpl }).getLeadDetails("USER_TOKEN", "LG123");
    assert.equal(details.id, "LG123");
    assert.equal(details.campaignName, "Winter Sale");
    assert.equal(details.adName, "Creative A");
    assert.equal(details.fieldData.length, 2);
    const url = new URL(calls[0].url);
    assert.ok(url.pathname.endsWith("/LG123"));
    for (const f of ["id", "form_id", "field_data", "campaign_name", "ad_id"]) {
      assert.ok((url.searchParams.get("fields") ?? "").split(",").includes(f), `missing field ${f}`);
    }
  });

  it("tolerates absent attribution and maps errors without leaking tokens", async () => {
    const secret = "EAA-never-in-lead-errors";
    const sparse = mockFetch(() => jsonResponse({ id: "LG9" }));
    const details = await new MetaGraphClient({ fetchImpl: sparse.fetchImpl }).getLeadDetails(secret, "LG9");
    assert.equal(details.campaignName, null);
    assert.deepEqual(details.fieldData, []);

    const failing = mockFetch(() =>
      jsonResponse({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }, 400)
    );
    await assert.rejects(
      new MetaGraphClient({ fetchImpl: failing.fetchImpl }).getLeadDetails(secret, "LG9"),
      (err) => {
        assert.ok(err instanceof MetaApiError);
        assert.equal(err.code, 190);
        assert.ok(!err.message.includes(secret));
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP end-to-end: reuses the shared dev server (repo convention) with an
// in-test mock Graph API. The dev server must carry
// META_GRAPH_BASE_URL=http://127.0.0.1:8101/v26.0 (test-only override;
// other suites never successfully call Meta, and disconnect revocation
// failures are swallowed by design, so the override is inert for them).
// If port 4000 is free, a fallback server is spawned with the same env.
// ---------------------------------------------------------------------------

const ROOT = path.join(import.meta.dirname, "..");
// App server: reuse the shared dev server (repo convention). The mock Graph
// API always listens on FIXED_MOCK_PORT so a restarted shared server can
// point META_GRAPH_BASE_URL at it (see header note).
const FALLBACK_PORT = 8099;
const FIXED_MOCK_PORT = 8101;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `wh${Date.now()}`;
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
  return `10.92.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
}

async function api(method, urlPath, { body, cookie, rawBody } = {}) {
  const headers = {};
  let payload = rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined);
  if (body !== undefined || rawBody !== undefined) headers["content-type"] = "application/json";
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
    if (Date.now() - start > timeoutMs) throw new Error(`port ${port} did not open`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Mock Graph API: canned lead details, programmable failures.
const mockState = { mode: "ok", calls: 0, failRemaining: 0 };
function leadDetailsPayload(leadgenId) {
  return {
    id: leadgenId,
    created_time: "2026-09-08T08:49:14+0000",
    ad_id: `ad-${RUN_TAG}`,
    adset_id: `adset-${RUN_TAG}`,
    campaign_id: `camp-${RUN_TAG}`,
    campaign_name: `Winter Sale ${RUN_TAG}`,
    adset_name: "Dhaka Broad",
    ad_name: "Creative A",
    form_id: `form-${RUN_TAG}`,
    field_data: [
      { name: "full_name", values: [`Webhook Prospect ${RUN_TAG}`] },
      { name: "email", values: [`prospect-${RUN_TAG}@example.com`] },
      { name: "phone_number", values: ["+8801712345678"] },
    ],
  };
}

let mockServer = null;
let server = null;
let ownServer = false;

before(async () => {
  mockServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const send = (payload, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const leadMatch = url.pathname.match(/^\/v26\.0\/([A-Za-z0-9_-]+)$/);
    if (req.method === "GET" && leadMatch && !url.pathname.endsWith("/accounts")) {
      mockState.calls += 1;
      if (mockState.failRemaining > 0) {
        mockState.failRemaining -= 1;
        send({ error: { message: "Transient failure.", type: "APIException", code: 2 } }, 500);
        return;
      }
      if (mockState.mode === "terminal") {
        send({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }, 400);
        return;
      }
      if (mockState.mode === "notfound") {
        send({ error: { message: "(#100) Object does not exist.", type: "OAuthException", code: 100 } }, 404);
        return;
      }
      send(leadDetailsPayload(leadMatch[1]));
      return;
    }
    send({ error: { message: "Unsupported mock request.", code: 100 } }, 400);
  });
  await new Promise((resolve, reject) => {
    mockServer.on("error", reject);
    mockServer.listen(FIXED_MOCK_PORT, "127.0.0.1", resolve);
  });

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
      META_GRAPH_BASE_URL: `http://127.0.0.1:${FIXED_MOCK_PORT}/v26.0`,
    },
  });
  ownServer = true;
  await waitForPort(PORT, 180_000);
}, { timeout: 200_000 });

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
      await client.query(`DELETE FROM "MetaLeadEvent" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "LeadActivity" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "Lead" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "MetaForm" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "MetaPage" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "MetaConnection" WHERE "businessId" = ANY($1)`, [bizIds]);
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

async function createBusiness(cookie, name) {
  const r = await api("POST", "/api/businesses", { body: { name }, cookie });
  assert.equal(r.status, 201, `create business failed: ${JSON.stringify(r.json)}`);
  return r.json.business;
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

async function dbExec(sql, params) {
  const client = pg();
  await client.connect();
  try {
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

const FORM_ID = `form-${RUN_TAG}`;
const PAGE_ID = `page-${RUN_TAG}`;

/** Seed connection + page + connected form directly (bypasses Meta entirely). */
async function seedMetaStack(businessId, { status = "ACTIVE", formId = FORM_ID, pageId = PAGE_ID } = {}) {
  const keyRaw = loadDotEnv().META_TOKEN_KEY;
  const { encryptToken: enc } = await import("../src/lib/integrations/meta/crypto.ts");
  const ciphertext = await enc(`EAA-seed-${RUN_TAG}`, keyRaw);
  const { randomUUID } = await import("node:crypto");
  await dbExec(
    `INSERT INTO "MetaConnection"
        ("id", "businessId", "metaUserId", "metaUserName", "accessTokenEncrypted", "scopes", "status", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', NOW())`,
    [randomUUID(), businessId, `meta-user-${RUN_TAG}`, `Seed Owner ${RUN_TAG}`, ciphertext, "pages_show_list leads_retrieval"]
  );
  // status override for the inactive-connection case
  if (status !== "ACTIVE") {
    await dbExec(`UPDATE "MetaConnection" SET "status" = $1 WHERE "businessId" = $2`, [status, businessId]);
  }
  await dbExec(
    `INSERT INTO "MetaPage"
      ("id", "businessId", "metaPageId", "name", "pageTokenEncrypted", "tasks", "selectedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
    [randomUUID(), businessId, pageId, `Seed Page ${RUN_TAG}`, ciphertext, "ADVERTISE MANAGE"]
  );
  await dbExec(
    `INSERT INTO "MetaForm"
      ("id", "businessId", "metaPageId", "metaFormId", "name", "status", "connectedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
    [randomUUID(), businessId, pageId, formId, `Seed Form ${RUN_TAG}`, "ACTIVE"]
  );
  return { formId, pageId };
}

function webhookPayload(leadgenId, formId = FORM_ID, pageId = PAGE_ID) {
  return {
    object: "page",
    entry: [
      {
        id: pageId,
        time: 1757320000,
        changes: [
          {
            field: "leadgen",
            value: {
              leadgen_id: leadgenId,
              page_id: pageId,
              form_id: formId,
              adgroup_id: `adset-${RUN_TAG}`,
              ad_id: `ad-${RUN_TAG}`,
              created_time: 1757320000,
            },
          },
        ],
      },
    ],
  };
}

async function postWebhook(payloadObject, opts = {}) {
  const rawBody = opts.rawOverride ?? JSON.stringify(payloadObject);
  // By default the signature covers exactly the bytes sent. Pass
  // `signOverride` to sign different bytes (simulating tampering).
  const signedBytes = opts.signOverride ?? rawBody;
  const headers = { "content-type": "application/json", "x-forwarded-for": nextIp() };
  if (!opts.noSignature) {
    const secret = opts.secretOverride ?? loadDotEnv().META_APP_SECRET;
    headers["x-hub-signature-256"] =
      `sha256=${crypto.createHmac("sha256", secret).update(signedBytes, "utf8").digest("hex")}`;
  }
  const res = await fetch(`${BASE}/api/webhooks/meta`, {
    method: "POST",
    headers,
    body: rawBody,
    redirect: "manual",
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

describe("webhook verification endpoint", () => {
  it("echoes the challenge on a valid handshake and rejects the rest", async () => {
    const token = loadDotEnv().META_WEBHOOK_VERIFY_TOKEN;
    assert.ok(token, "META_WEBHOOK_VERIFY_TOKEN missing in .env");
    const ok = await fetch(
      `${BASE}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=CHALLENGE-ABC`,
      { redirect: "manual" }
    );
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "CHALLENGE-ABC");

    const wrong = await fetch(
      `${BASE}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHALLENGE-ABC`,
      { redirect: "manual" }
    );
    assert.equal(wrong.status, 403);
    const badMode = await fetch(
      `${BASE}/api/webhooks/meta?hub.mode=unsubscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=X`,
      { redirect: "manual" }
    );
    assert.equal(badMode.status, 403);
    const missing = await fetch(`${BASE}/api/webhooks/meta`, { redirect: "manual" });
    assert.equal(missing.status, 403);
  });
});

describe("webhook event intake", () => {
  it("rejects unsigned, mistyped, and malformed deliveries", async () => {
    const payload = webhookPayload(`lg-${RUN_TAG}-unsigned`);
    // No signature.
    assert.equal((await postWebhook(payload, { noSignature: true })).status, 403);
    // Wrong secret.
    assert.equal((await postWebhook(payload, { secretOverride: "wrong-secret" })).status, 403);
    // Tampered body: signature covers the original bytes, body is altered.
    const raw = JSON.stringify(payload);
    assert.equal((await postWebhook(payload, { rawOverride: `${raw} `, signOverride: raw })).status, 403);
    // Signed garbage.
    const garbage = await postWebhook(null, { rawOverride: "not-json{{{", secretOverride: undefined });
    assert.equal(garbage.status, 400);
    // Non-page object is acknowledged with nothing to do.
    const userPayload = { object: "user", entry: [] };
    const userRes = await postWebhook(userPayload);
    assert.equal(userRes.status, 200);
    assert.equal(userRes.json.received, 0);
  });

  it("skips events for unconnected forms without storing anything", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} noform`);
    await seedMetaStack(biz.id, { formId: `form-${RUN_TAG}-orphan-stack`, pageId: `page-${RUN_TAG}-orphan-stack` });
    const res = await postWebhook(webhookPayload(`lg-${RUN_TAG}-orphan`, `unknown-form-${RUN_TAG}`));
    assert.equal(res.status, 200);
    assert.equal(res.json.skipped, 1);
    const events = await dbRows(`SELECT id FROM "MetaLeadEvent" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(events.length, 0, "orphan event must not be stored");
    const leads = await dbRows(`SELECT id FROM "Lead" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(leads.length, 0, "orphan event must not create leads");
  });
});

describe("webhook lead creation (acceptance)", () => {
  it("test webhook produces a fully-attributed CRM lead", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} happy`);
    await seedMetaStack(biz.id, { formId: `form-${RUN_TAG}-happy`, pageId: `page-${RUN_TAG}-happy` });
    const leadgenId = `lg-${RUN_TAG}-happy`;

    mockState.mode = "ok";
    mockState.failRemaining = 0;
    const res = await postWebhook(webhookPayload(leadgenId, `form-${RUN_TAG}-happy`, `page-${RUN_TAG}-happy`));
    assert.equal(res.status, 200, `webhook failed: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.received, 1);
    assert.equal(res.json.created, 1);

    const leads = await dbRows(
      `SELECT "name", "email", "phone", "status", "source", "campaignName", "adSetName", "adName", "facebookLeadId", "businessId"
       FROM "Lead" WHERE "businessId" = $1`,
      [biz.id]
    );
    assert.equal(leads.length, 1);
    const lead = leads[0];
    assert.equal(lead.name, `Webhook Prospect ${RUN_TAG}`);
    assert.equal(lead.email, `prospect-${RUN_TAG}@example.com`);
    assert.equal(lead.phone, "+8801712345678");
    assert.equal(lead.status, "NEW");
    assert.equal(lead.source, "facebook");
    assert.equal(lead.campaignName, `Winter Sale ${RUN_TAG}`);
    assert.equal(lead.adSetName, "Dhaka Broad");
    assert.equal(lead.adName, "Creative A");
    assert.equal(lead.facebookLeadId, leadgenId);
    assert.equal(lead.businessId, biz.id);

    const events = await dbRows(
      `SELECT "status", "attempts", "leadId", "lastError" FROM "MetaLeadEvent" WHERE "businessId" = $1`,
      [biz.id]
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "DONE");
    assert.equal(events[0].attempts, 0);
    assert.ok(events[0].leadId, "event must link the created lead");
    assert.equal(events[0].lastError, null);

    // Timeline records the import with a system actor.
    const activities = await dbRows(
      `SELECT "type", "actorId", "body" FROM "LeadActivity" WHERE "businessId" = $1`,
      [biz.id]
    );
    const created = activities.find((a) => a.type === "CREATED");
    assert.ok(created, "missing CREATED timeline entry");
    assert.equal(created.actorId, null);
    assert.ok(created.body.includes(leadgenId));
  });

  it("duplicate deliveries never create duplicate leads", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} dupe`);
    await seedMetaStack(biz.id, { formId: `form-${RUN_TAG}-dupe`, pageId: `page-${RUN_TAG}-dupe` });
    const leadgenId = `lg-${RUN_TAG}-dupe`;
    const formId = `form-${RUN_TAG}-dupe`;
    const pageId = `page-${RUN_TAG}-dupe`;
    mockState.mode = "ok";
    mockState.failRemaining = 0;

    const first = await postWebhook(webhookPayload(leadgenId, formId, pageId));
    assert.equal(first.json.created, 1);
    for (let i = 0; i < 3; i++) {
      const redelivery = await postWebhook(webhookPayload(leadgenId, formId, pageId));
      assert.equal(redelivery.status, 200);
      assert.equal(redelivery.json.duplicates, 1, `redelivery ${i} not counted as duplicate`);
      assert.equal(redelivery.json.created, 0);
    }
    const leads = await dbRows(
      `SELECT COUNT(*)::int AS n FROM "Lead" WHERE "businessId" = $1 AND "facebookLeadId" = $2`,
      [biz.id, leadgenId]
    );
    assert.equal(leads[0].n, 1, "duplicate lead created");
    const events = await dbRows(
      `SELECT COUNT(*)::int AS n FROM "MetaLeadEvent" WHERE "businessId" = $1 AND "leadgenId" = $2`,
      [biz.id, leadgenId]
    );
    assert.equal(events[0].n, 1, "duplicate event row created");
  });

  it("a pre-existing lead links instead of duplicating", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} preexisting`);
    await seedMetaStack(biz.id, { formId: `form-${RUN_TAG}-pre`, pageId: `page-${RUN_TAG}-pre` });
    const leadgenId = `lg-${RUN_TAG}-preexisting`;
    const formId = `form-${RUN_TAG}-pre`;
    const pageId = `page-${RUN_TAG}-pre`;
    mockState.mode = "ok";
    mockState.failRemaining = 0;

    // Manual lead with the same facebook id, then the webhook arrives late.
    const created = await api("POST", `/api/businesses/${biz.id}/leads`, {
      body: { name: "Manual entry", facebookLeadId: leadgenId },
      cookie: owner.cookie,
    });
    assert.equal(created.status, 201);
    const res = await postWebhook(webhookPayload(leadgenId, formId, pageId));
    assert.equal(res.status, 200);
    assert.equal(res.json.duplicates, 1);
    const leads = await dbRows(
      `SELECT COUNT(*)::int AS n FROM "Lead" WHERE "businessId" = $1 AND "facebookLeadId" = $2`,
      [biz.id, leadgenId]
    );
    assert.equal(leads[0].n, 1);
    const events = await dbRows(`SELECT "status", "leadId" FROM "MetaLeadEvent" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(events[0].status, "DONE");
    assert.equal(events[0].leadId, created.json.lead.id);
  });
});

describe("webhook retries and terminal failures", () => {
  it("a failed Graph request is retried safely exactly once", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} retry`);
    await seedMetaStack(biz.id, { formId: `form-${RUN_TAG}-retry`, pageId: `page-${RUN_TAG}-retry` });
    const leadgenId = `lg-${RUN_TAG}-retry`;
    const payload = () => webhookPayload(leadgenId, `form-${RUN_TAG}-retry`, `page-${RUN_TAG}-retry`);

    // Two transient 500s, then success. First delivery fails inline.
    mockState.mode = "ok";
    mockState.failRemaining = 1;
    const first = await postWebhook(payload());
    assert.equal(first.status, 200);
    assert.equal(first.json.deferred, 1);
    let events = await dbRows(
      `SELECT "status", "attempts", "nextRetryAt", "lastError", "leadId" FROM "MetaLeadEvent" WHERE "businessId" = $1`,
      [biz.id]
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "FAILED");
    assert.equal(events[0].attempts, 1);
    assert.ok(events[0].nextRetryAt, "retry must be scheduled");
    assert.ok(events[0].lastError, "failure must be recorded");
    assert.ok(!events[0].lastError.includes("EAA"), "token material in lastError");
    assert.equal(events[0].leadId, null);

    // Immediate redelivery waits for the backoff (no new Graph call, no lead).
    const callsBefore = mockState.calls;
    const early = await postWebhook(payload());
    assert.equal(early.json.deferred, 1);
    assert.equal(mockState.calls, callsBefore, "backoff must suppress reprocessing");

    // After the backoff elapses, redelivery succeeds exactly once.
    await dbExec(`UPDATE "MetaLeadEvent" SET "nextRetryAt" = NOW() - INTERVAL '1 second' WHERE "businessId" = $1`, [biz.id]);
    const late = await postWebhook(payload());
    assert.equal(late.json.created, 1);
    events = await dbRows(`SELECT "status", "lastError", "nextRetryAt" FROM "MetaLeadEvent" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(events[0].status, "DONE");
    assert.equal(events[0].lastError, null);
    assert.equal(events[0].nextRetryAt, null);
    const leads = await dbRows(`SELECT COUNT(*)::int AS n FROM "Lead" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(leads[0].n, 1, "retry created a duplicate lead");
  });

  it("terminal Graph errors and missing connections fail without retry", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} terminal`);
    await seedMetaStack(biz.id, { formId: `form-${RUN_TAG}-term`, pageId: `page-${RUN_TAG}-term` });

    // OAuthException 190: terminal, no retry scheduled.
    mockState.mode = "terminal";
    mockState.failRemaining = 0;
    const bad = await postWebhook(webhookPayload(`lg-${RUN_TAG}-badtoken`, `form-${RUN_TAG}-term`, `page-${RUN_TAG}-term`));
    assert.equal(bad.json.deferred, 1);
    let events = await dbRows(
      `SELECT "status", "attempts", "nextRetryAt" FROM "MetaLeadEvent" WHERE "businessId" = $1`,
      [biz.id]
    );
    assert.equal(events[0].status, "FAILED");
    assert.equal(events[0].attempts, 1);
    assert.equal(events[0].nextRetryAt, null, "terminal failure must not schedule retry");

    // Missing connection: terminal as well.
    const owner2 = await registerAndLogin();
    const biz2 = await createBusiness(owner2.cookie, `${RUN_TAG} noconnection`);
    const { randomUUID: uuid2 } = await import("node:crypto");
    await dbExec(
      `INSERT INTO "MetaForm" ("id","businessId","metaPageId","metaFormId","name","status","connectedAt","updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', NOW(), NOW())`,
      [uuid2(), biz2.id, `page-${RUN_TAG}-nc`, `form-${RUN_TAG}-nc`, `Form NC ${RUN_TAG}`]
    );
    mockState.mode = "ok";
    const noConn = await postWebhook(webhookPayload(`lg-${RUN_TAG}-nc`, `form-${RUN_TAG}-nc`, `page-${RUN_TAG}-nc`));
    assert.equal(noConn.status, 200);
    events = await dbRows(`SELECT "status", "attempts" FROM "MetaLeadEvent" WHERE "businessId" = $1`, [biz2.id]);
    assert.equal(events[0].status, "FAILED");
    const leads = await dbRows(`SELECT COUNT(*)::int AS n FROM "Lead" WHERE "businessId" = $1`, [biz2.id]);
    assert.equal(leads[0].n, 0);
  });
});

describe("webhook tenant isolation", () => {
  it("leads land only in the owning business and leak nowhere", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} w-tenant-A`);
    const bizB = await createBusiness(b.cookie, `${RUN_TAG} w-tenant-B`);
    await seedMetaStack(bizA.id, { formId: `form-${RUN_TAG}-wtenant`, pageId: `page-${RUN_TAG}-wtenant` });
    mockState.mode = "ok";
    mockState.failRemaining = 0;

    const res = await postWebhook(webhookPayload(`lg-${RUN_TAG}-wtenant`, `form-${RUN_TAG}-wtenant`, `page-${RUN_TAG}-wtenant`));
    assert.equal(res.json.created, 1);

    // B's CRM list (authenticated API) contains nothing of A's.
    const listB = await api("GET", `/api/businesses/${bizB.id}/leads`, { cookie: b.cookie });
    assert.equal(listB.status, 200);
    assert.equal(listB.json.leads.length, 0);
    const listA = await api("GET", `/api/businesses/${bizA.id}/leads`, { cookie: a.cookie });
    assert.equal(listA.status, 200);
    assert.equal(listA.json.leads.length, 1);
    assert.equal(listA.json.leads[0].facebookLeadId, `lg-${RUN_TAG}-wtenant`);

    // B cannot reach A's event rows through any lead API (different ids entirely).
    const eventsB = await dbRows(`SELECT COUNT(*)::int AS n FROM "MetaLeadEvent" WHERE "businessId" = $1`, [bizB.id]);
    assert.equal(eventsB[0].n, 0);
  });
});
