// WhatsApp Cloud API integration tests.
//
// Two layers, matching the module boundaries:
//  1. Pure unit tests with a mocked Graph API (direct .ts imports work with
//     Node type-stripping; client.ts has no project-local imports):
//     phone fetch, number listing, health parsing, Bearer auth, error
//     mapping, token hygiene.
//  2. HTTP end-to-end against a dedicated production server (`next start`
//     on 8102 — a second `next dev` is blocked by Next's single-dev-server
//     lock, so this file builds once via `npm run build` then serves the
//     production bundle) with META_GRAPH_BASE_URL pointed at an in-test
//     mock Graph API on an ephemeral port. No fixed ports anywhere: fully
//     parallel-safe. Covers connect (verify-then-store), redacted status,
//     live health + persistence, disconnect, gating, validation, encrypted
//     storage, and settings UI isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";
import { decryptToken } from "../src/lib/integrations/meta/crypto.ts";
import { MetaApiError, WhatsAppCloudClient } from "../src/lib/integrations/whatsapp/client.ts";

const RUN_TAG = `wa${Date.now()}`;

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

describe("WhatsAppCloudClient (mocked Graph API)", () => {
  it("fetches a phone number with Bearer auth and documented fields", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse({
        id: "PHONE1",
        display_phone_number: "+1 555-0100",
        verified_name: "Acme Corp",
        quality_rating: "GREEN",
        code_verification_status: "VERIFIED",
      })
    );
    const phone = await new WhatsAppCloudClient({ fetchImpl }).getPhoneNumber({
      phoneNumberId: "PHONE1",
      token: "SYS_TOKEN",
    });
    assert.deepEqual(phone, {
      id: "PHONE1",
      displayPhoneNumber: "+1 555-0100",
      verifiedName: "Acme Corp",
      qualityRating: "GREEN",
      codeVerificationStatus: "VERIFIED",
    });
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.ok(url.hostname === "graph.facebook.com");
    assert.ok(url.pathname.endsWith("/PHONE1"));
    assert.equal(url.searchParams.get("fields"), "id,display_phone_number,verified_name,quality_rating,code_verification_status");
    // Bearer header auth: token must not appear in the URL.
    assert.equal(url.searchParams.get("access_token"), null);
    assert.ok(!calls[0].url.includes("SYS_TOKEN"));
    assert.equal(calls[0].init?.headers?.Authorization, "Bearer SYS_TOKEN");
  });

  it("lists WABA phone numbers via the documented edge", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse({
        data: [
          { id: "P1", display_phone_number: "+1", verified_name: "A", quality_rating: "GREEN" },
          { id: "P2", display_phone_number: "+2" },
          { id: 42 },
        ],
      })
    );
    const numbers = await new WhatsAppCloudClient({ fetchImpl }).listPhoneNumbers({
      wabaId: "WABA1",
      token: "SYS_TOKEN",
    });
    assert.equal(numbers.length, 2, "malformed entries must be skipped");
    assert.equal(numbers[0].id, "P1");
    assert.equal(numbers[1].verifiedName, null);
    const url = new URL(calls[0].url);
    assert.ok(url.pathname.endsWith("/WABA1/phone_numbers"));
  });

  it("parses messaging health with entity breakdown", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse({
        id: "PHONE1",
        health_status: {
          can_send_message: "LIMITED",
          entities: [
            { entity_type: "PHONE_NUMBER", id: "PHONE1", can_send_message: "AVAILABLE" },
            { entity_type: "WABA", id: "WABA1", can_send_message: "LIMITED" },
            { nope: true },
          ],
        },
      })
    );
    const health = await new WhatsAppCloudClient({ fetchImpl }).getPhoneHealth({
      phoneNumberId: "PHONE1",
      token: "SYS_TOKEN",
    });
    assert.equal(health.canSendMessage, "LIMITED");
    assert.equal(health.entities.length, 2);
    assert.deepEqual(health.entities[0], { entityType: "PHONE_NUMBER", id: "PHONE1", canSendMessage: "AVAILABLE" });
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get("fields"), "id,health_status");
  });

  it("maps Meta errors without leaking tokens", async () => {
    const secret = "SYS_never-in-errors";
    const failing = mockFetch(() =>
      jsonResponse({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }, 400)
    );
    await assert.rejects(
      new WhatsAppCloudClient({ fetchImpl: failing.fetchImpl }).getPhoneNumber({
        phoneNumberId: "P",
        token: secret,
      }),
      (err) => {
        assert.ok(err instanceof MetaApiError);
        assert.equal(err.message, "Invalid OAuth access token.");
        assert.equal(err.code, 190);
        return true;
      }
    );
    const down = mockFetch(() => {
      throw new Error("socket hang up");
    });
    await assert.rejects(
      new WhatsAppCloudClient({ fetchImpl: down.fetchImpl }).getPhoneHealth({
        phoneNumberId: "P",
        token: secret,
      }),
      (err) => {
        assert.ok(!String(err.message).includes(secret));
        return true;
      }
    );
    const shape = mockFetch(() => jsonResponse({ id: 42 }));
    await assert.rejects(
      new WhatsAppCloudClient({ fetchImpl: shape.fetchImpl }).getPhoneNumber({ phoneNumberId: "P", token: "T" }),
      MetaApiError
    );
    const noHealth = mockFetch(() => jsonResponse({ id: "P" }));
    await assert.rejects(
      new WhatsAppCloudClient({ fetchImpl: noHealth.fetchImpl }).getPhoneHealth({ phoneNumberId: "P", token: "T" }),
      MetaApiError
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP end-to-end: dedicated prod server + in-test mock Graph API.
// ---------------------------------------------------------------------------

const ROOT = path.join(import.meta.dirname, "..");
const APP_PORT = 8102;
let BASE = `http://127.0.0.1:${APP_PORT}`;
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
  return `10.93.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
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

// Mock Graph API. Behavior is driven by request ids so tests stay
// deterministic with zero shared state:
// - phone id containing ".badtoken." -> 400/190; ".missing." -> 404/100.
// - phone id containing ".blocked." -> health BLOCKED, else AVAILABLE.
// - WABA phone list returns `<wabaId>-phone-1` (+ `-phone-2`).
function mockPhonePayload(phoneId) {
  return {
    id: phoneId,
    display_phone_number: "+1 555-0100",
    verified_name: `Acme ${RUN_TAG}`,
    quality_rating: "GREEN",
    code_verification_status: "VERIFIED",
  };
}

function mockHealthPayload(phoneId, blocked) {
  return {
    id: phoneId,
    health_status: blocked
      ? {
          can_send_message: "BLOCKED",
          entities: [
            { entity_type: "PHONE_NUMBER", id: phoneId, can_send_message: "BLOCKED" },
            { entity_type: "WABA", id: "WABA1", can_send_message: "AVAILABLE" },
            { entity_type: "APP", id: "APP1", can_send_message: "AVAILABLE" },
          ],
        }
      : {
          can_send_message: "AVAILABLE",
          entities: [
            { entity_type: "PHONE_NUMBER", id: phoneId, can_send_message: "AVAILABLE" },
            { entity_type: "WABA", id: "WABA1", can_send_message: "AVAILABLE" },
            { entity_type: "APP", id: "APP1", can_send_message: "AVAILABLE" },
          ],
        },
  };
}

let mockServer = null;
let mockPort = 0;
let server = null;

before(async () => {
  mockServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const send = (payload, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const wabaPhones = url.pathname.match(/^\/v26\.0\/([A-Za-z0-9_.-]+)\/phone_numbers$/);
    if (req.method === "GET" && wabaPhones) {
      const wabaId = wabaPhones[1];
      if (wabaId.includes(".badtoken.")) {
        send({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }, 400);
        return;
      }
      send({
        data: [
          { ...mockPhonePayload(`${wabaId}-phone-1`), id: `${wabaId}-phone-1` },
          { ...mockPhonePayload(`${wabaId}-phone-2`), id: `${wabaId}-phone-2` },
        ],
      });
      return;
    }
    const node = url.pathname.match(/^\/v26\.0\/([A-Za-z0-9_.-]+)$/);
    if (req.method === "GET" && node) {
      const nodeId = node[1];
      if (nodeId.includes(".badtoken.")) {
        send({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }, 400);
        return;
      }
      if (nodeId.includes(".missing.")) {
        send({ error: { message: "(#100) Object does not exist.", type: "OAuthException", code: 100 } }, 404);
        return;
      }
      if ((url.searchParams.get("fields") ?? "").split(",").includes("health_status")) {
        send(mockHealthPayload(nodeId, nodeId.endsWith("-phone-2")));
        return;
      }
      send(mockPhonePayload(nodeId));
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

describe("whatsapp connect", () => {
  it("verifies credentials live, then stores redacted encrypted state", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} connect`);
    const wabaId = `waba-${RUN_TAG}`;
    const phoneId = `${wabaId}-phone-1`;
    const token = `SYS-token-${RUN_TAG}`;

    const res = await api("POST", `/api/businesses/${biz.id}/whatsapp/connect`, {
      body: { wabaId, phoneNumberId: phoneId, accessToken: token },
      cookie: owner.cookie,
    });
    assert.equal(res.status, 200, `connect failed: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.connection.connected, true);
    assert.equal(res.json.connection.wabaId, wabaId);
    assert.equal(res.json.connection.phoneNumberId, phoneId);
    assert.equal(res.json.connection.displayPhoneNumber, "+1 555-0100");
    assert.equal(res.json.connection.verifiedName, `Acme ${RUN_TAG}`);
    const serialized = JSON.stringify(res.json);
    assert.ok(!serialized.includes(token), "token leaked in connect response");
    assert.ok(!serialized.includes("accessToken"), "token field leaked in connect response");

    // Stored ciphertext decrypts to the original; display metadata persisted.
    const rows = await dbRows(`SELECT * FROM "WhatsAppConnection" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].accessTokenEncrypted.startsWith("v1."));
    assert.ok(!rows[0].accessTokenEncrypted.includes(token));
    const keyRaw = loadDotEnv().META_TOKEN_KEY;
    assert.equal(await decryptToken(rows[0].accessTokenEncrypted, keyRaw), token);

    // Reconnect replaces the row instead of duplicating.
    const again = await api("POST", `/api/businesses/${biz.id}/whatsapp/connect`, {
      body: { wabaId, phoneNumberId: `${wabaId}-phone-2`, accessToken: token },
      cookie: owner.cookie,
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.connection.phoneNumberId, `${wabaId}-phone-2`);
    const count = await dbRows(`SELECT COUNT(*)::int AS n FROM "WhatsAppConnection" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(count[0].n, 1);
  });

  it("rejects bad input without touching Meta", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} validation`);
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/whatsapp/connect`, { body: {}, cookie: owner.cookie })).status,
      422
    );
    assert.equal(
      (
        await api("POST", `/api/businesses/${biz.id}/whatsapp/connect`, {
          body: { wabaId: "w", phoneNumberId: "p" },
          cookie: owner.cookie,
        })
      ).status,
      422
    );
    const rows = await dbRows(`SELECT COUNT(*)::int AS n FROM "WhatsAppConnection" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(rows[0].n, 0);
  });

  it("rejects invalid credentials and foreign numbers with 409", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} rejected`);
    // Bad token on the phone lookup.
    assert.equal(
      (
        await api("POST", `/api/businesses/${biz.id}/whatsapp/connect`, {
          body: { wabaId: "w", phoneNumberId: "p.badtoken.q", accessToken: "t" },
          cookie: owner.cookie,
        })
      ).status,
      409
    );
    // Phone exists but is not on this WABA.
    assert.equal(
      (
        await api("POST", `/api/businesses/${biz.id}/whatsapp/connect`, {
          body: { wabaId: `other-waba-${RUN_TAG}`, phoneNumberId: `foreign-phone-${RUN_TAG}`, accessToken: "t" },
          cookie: owner.cookie,
        })
      ).status,
      409
    );
    const rows = await dbRows(`SELECT COUNT(*)::int AS n FROM "WhatsAppConnection" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(rows[0].n, 0, "failed connect must not store anything");
  });

  it("gates connect by session, membership, and manager role", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} gates`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    const body = { wabaId: "w", phoneNumberId: "p", accessToken: "t" };
    assert.equal((await api("POST", `/api/businesses/${biz.id}/whatsapp/connect`, { body })).status, 401);
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/whatsapp/connect`, { body, cookie: sales.cookie })).status,
      403
    );
    const stranger = await registerAndLogin();
    await createBusiness(stranger.cookie, `${RUN_TAG} stranger`);
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/whatsapp/connect`, { body, cookie: stranger.cookie })).status,
      403
    );
  });
});

describe("whatsapp status, health, and disconnect", () => {
  it("serves redacted status and checks live health with persistence", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} health`);
    const wabaId = `waba-${RUN_TAG}-h`;
    const token = `SYS-token-${RUN_TAG}-h`;

    const empty = await api("GET", `/api/businesses/${biz.id}/whatsapp`, { cookie: owner.cookie });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { connected: false });

    await api("POST", `/api/businesses/${biz.id}/whatsapp/connect`, {
      body: { wabaId, phoneNumberId: `${wabaId}-phone-1`, accessToken: token },
      cookie: owner.cookie,
    });
    const status = await api("GET", `/api/businesses/${biz.id}/whatsapp`, { cookie: owner.cookie });
    assert.equal(status.json.connected, true);
    assert.equal(status.json.displayPhoneNumber, "+1 555-0100");
    assert.ok(!JSON.stringify(status.json).includes(token), "token leaked in status");
    assert.ok(!JSON.stringify(status.json).includes("accessToken"), "token field leaked in status");

    const health = await api("POST", `/api/businesses/${biz.id}/whatsapp/health`, { cookie: owner.cookie });
    assert.equal(health.status, 200, `health failed: ${JSON.stringify(health.json)}`);
    assert.equal(health.json.health.canSendMessage, "AVAILABLE");
    assert.equal(health.json.health.entities.length, 3);
    const rows = await dbRows(
      `SELECT "healthStatus", "lastCheckedAt" FROM "WhatsAppConnection" WHERE "businessId" = $1`,
      [biz.id]
    );
    assert.equal(rows[0].healthStatus, "AVAILABLE");
    assert.ok(rows[0].lastCheckedAt, "health check time not persisted");
  });

  it("surfaces BLOCKED health and gates health/disconnect", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} blocked`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");
    const wabaId = `waba-${RUN_TAG}-b`;
    await api("POST", `/api/businesses/${biz.id}/whatsapp/connect`, {
      body: { wabaId, phoneNumberId: `${wabaId}-phone-2`, accessToken: "t" },
      cookie: owner.cookie,
    });
    const health = await api("POST", `/api/businesses/${biz.id}/whatsapp/health`, { cookie: owner.cookie });
    assert.equal(health.json.health.canSendMessage, "BLOCKED");

    // SALES can read status but cannot check health or disconnect.
    assert.equal((await api("GET", `/api/businesses/${biz.id}/whatsapp`, { cookie: sales.cookie })).status, 200);
    assert.equal((await api("POST", `/api/businesses/${biz.id}/whatsapp/health`, { cookie: sales.cookie })).status, 403);
    assert.equal((await api("DELETE", `/api/businesses/${biz.id}/whatsapp`, { cookie: sales.cookie })).status, 403);
    // Health with no connection is 404, not 500.
    const fresh = await registerAndLogin();
    const freshBiz = await createBusiness(fresh.cookie, `${RUN_TAG} fresh`);
    assert.equal((await api("POST", `/api/businesses/${freshBiz.id}/whatsapp/health`, { cookie: fresh.cookie })).status, 404);
    // Disconnect removes the row; repeat is 404.
    assert.equal((await api("DELETE", `/api/businesses/${biz.id}/whatsapp`, { cookie: owner.cookie })).status, 200);
    const rows = await dbRows(`SELECT COUNT(*)::int AS n FROM "WhatsAppConnection" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(rows[0].n, 0);
    assert.equal((await api("DELETE", `/api/businesses/${biz.id}/whatsapp`, { cookie: owner.cookie })).status, 404);
    assert.equal((await api("GET", `/api/businesses/${biz.id}/whatsapp`)).status, 401);
  });
});

describe("whatsapp tenant isolation + UI", () => {
  it("keeps Business B blind to Business A's connection", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} iso-A`);
    const bizB = await createBusiness(b.cookie, `${RUN_TAG} iso-B`);
    const wabaA = `waba-${RUN_TAG}-A`;
    const tokenA = `SYS-token-${RUN_TAG}-A`;
    await api("POST", `/api/businesses/${bizA.id}/whatsapp/connect`, {
      body: { wabaId: wabaA, phoneNumberId: `${wabaA}-phone-1`, accessToken: tokenA },
      cookie: a.cookie,
    });

    // Every A-scoped endpoint denies B without leaking identifiers.
    for (const [method, urlPath, body] of [
      ["GET", `/api/businesses/${bizA.id}/whatsapp`, undefined],
      ["POST", `/api/businesses/${bizA.id}/whatsapp/connect`, { wabaId: "w", phoneNumberId: "p", accessToken: "t" }],
      ["POST", `/api/businesses/${bizA.id}/whatsapp/health`, undefined],
      ["DELETE", `/api/businesses/${bizA.id}/whatsapp`, undefined],
    ]) {
      const r = await api(method, urlPath, { body, cookie: b.cookie });
      assert.equal(r.status, 403, `${method} ${urlPath} -> ${r.status}`);
      assert.ok(!JSON.stringify(r.json).includes(wabaA), "WABA id leaked cross-tenant");
      assert.ok(!JSON.stringify(r.json).includes(tokenA), "token leaked cross-tenant");
    }

    // B's own status is disconnected; A's rows are untouched.
    const selB = await api("GET", `/api/businesses/${bizB.id}/whatsapp`, { cookie: b.cookie });
    assert.deepEqual(selB.json, { connected: false });
    const rows = await dbRows(`SELECT COUNT(*)::int AS n FROM "WhatsAppConnection" WHERE "businessId" = $1`, [bizA.id]);
    assert.equal(rows[0].n, 1);

    // Settings UI renders connection metadata to A only.
    const pageA = await getHtml(`/dashboard/settings/integrations?businessId=${bizA.id}`, a.cookie);
    assert.equal(pageA.status, 200);
    assert.ok(pageA.html.includes("+1 555-0100"), "phone number missing for owner");
    assert.ok(pageA.html.includes(wabaA), "WABA id missing for owner");
    assert.ok(!pageA.html.includes(tokenA), "token in HTML");
    const pageB = await getHtml(`/dashboard/settings/integrations?businessId=${bizB.id}`, b.cookie);
    assert.equal(pageB.status, 200);
    assert.ok(!pageB.html.includes("+1 555-0100"), "phone number leaked cross-tenant");
    assert.ok(!pageB.html.includes(wabaA), "WABA id leaked cross-tenant");
  });
});
