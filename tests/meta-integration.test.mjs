// Meta (Facebook Lead Ads) integration tests.
//
// Two layers, matching the module boundaries:
//  1. Pure unit tests with a mocked Graph API (direct .ts imports work with
//     Node type-stripping; these modules have no project-local imports):
//     token encryption, OAuth state, and the MetaGraphClient.
//  2. HTTP tests against the dev server: OAuth route auth/tenant gating,
//     redacted status shape, disconnect flow, and settings UI isolation.
//     The Graph API itself is never touched from HTTP tests.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";
import {
  decryptToken,
  encryptToken,
  isEncryptedToken,
  MetaCryptoError,
} from "../src/lib/integrations/meta/crypto.ts";
import { signOAuthState, verifyOAuthState } from "../src/lib/integrations/meta/state.ts";
import {
  META_LEAD_SCOPES,
  MetaApiError,
  MetaGraphClient,
} from "../src/lib/integrations/meta/client.ts";

const TEST_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_KEY_HEX = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const TEST_SECRET = "test-only-hmac-secret";

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

describe("token encryption (AES-256-GCM)", () => {
  it("round-trips and never returns plaintext-looking ciphertext", async () => {
    const token = "EAAtest-user-token-123";
    const ct = await encryptToken(token, TEST_KEY_HEX);
    assert.ok(isEncryptedToken(ct));
    assert.ok(!ct.includes(token));
    assert.equal(await decryptToken(ct, TEST_KEY_HEX), token);
  });

  it("uses a random IV per call", async () => {
    const a = await encryptToken("same-token", TEST_KEY_HEX);
    const b = await encryptToken("same-token", TEST_KEY_HEX);
    assert.notEqual(a, b);
    assert.equal(await decryptToken(a, TEST_KEY_HEX), "same-token");
    assert.equal(await decryptToken(b, TEST_KEY_HEX), "same-token");
  });

  it("rejects wrong keys, tampering, and malformed payloads", async () => {
    const ct = await encryptToken("secret-token", TEST_KEY_HEX);
    await assert.rejects(decryptToken(ct, OTHER_KEY_HEX), MetaCryptoError);
    const parts = ct.split(".");
    const tampered = `${parts[0]}.${parts[1]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    await assert.rejects(decryptToken(tampered, TEST_KEY_HEX), MetaCryptoError);
    for (const bad of ["", "plaintext-token", "v1.only-two", "v2.a.b", "v1.!!!.???"]) {
      await assert.rejects(decryptToken(bad, TEST_KEY_HEX), MetaCryptoError);
    }
    await assert.rejects(encryptToken("", TEST_KEY_HEX), MetaCryptoError);
  });

  it("rejects misconfigured keys with a safe message", async () => {
    await assert.rejects(encryptToken("x", "too-short"), MetaCryptoError);
    await assert.rejects(decryptToken("v1.a.b", "too-short"), MetaCryptoError);
    try {
      await encryptToken("x", "too-short");
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(!String(err.message).includes("too-short"));
    }
  });

  it("accepts base64 keys as well as hex", async () => {
    const raw = Buffer.from(TEST_KEY_HEX, "hex");
    const b64 = raw.toString("base64");
    const ct = await encryptToken("tok", b64);
    assert.equal(await decryptToken(ct, TEST_KEY_HEX), "tok");
  });

  it("error messages never contain token material", async () => {
    const token = "EAA-super-secret-token-xyz";
    const ct = await encryptToken(token, TEST_KEY_HEX);
    try {
      await decryptToken(ct, OTHER_KEY_HEX);
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(!String(err.message).includes(token));
      assert.ok(!String(err.message).includes(ct));
    }
  });
});

describe("OAuth state", () => {
  it("signs and verifies a full round-trip", async () => {
    const state = await signOAuthState("biz-1", "user-1", { secret: TEST_SECRET });
    const parsed = await verifyOAuthState(state, { secret: TEST_SECRET });
    assert.ok(parsed);
    assert.equal(parsed.businessId, "biz-1");
    assert.equal(parsed.userId, "user-1");
    assert.ok(typeof parsed.nonce === "string" && parsed.nonce.length > 0);
  });

  it("rejects tampering, expiry, wrong secrets, and malformed input", async () => {
    const state = await signOAuthState("biz-1", "user-1", { secret: TEST_SECRET, nowMs: 1_000_000 });
    assert.ok(await verifyOAuthState(state, { secret: TEST_SECRET, nowMs: 1_000_000 }));
    // Tampered payload.
    const parts = state.split(".");
    const tampered = `v1.${parts[1].slice(0, -2)}ab.${parts[2]}`;
    assert.equal(await verifyOAuthState(tampered, { secret: TEST_SECRET }), null);
    // Expired.
    assert.equal(
      await verifyOAuthState(state, { secret: TEST_SECRET, nowMs: 1_000_000 + 11 * 60 * 1000 }),
      null
    );
    // Wrong secret.
    assert.equal(await verifyOAuthState(state, { secret: "other-secret" }), null);
    // Malformed.
    for (const bad of [undefined, null, "", "v1.only", "v1.a.b.c", "garbage"]) {
      assert.equal(await verifyOAuthState(bad, { secret: TEST_SECRET }), null);
    }
  });
});

describe("MetaGraphClient (mocked Graph API)", () => {
  it("exchanges a code with the documented parameters", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse({ access_token: "SHORT_LIVED", token_type: "bearer", expires_in: 3600 })
    );
    const client = new MetaGraphClient({ fetchImpl });
    const token = await client.exchangeCodeForToken({
      appId: "APP_ID",
      appSecret: "APP_SECRET",
      redirectUri: "https://app.example/api/meta/callback",
      code: "AUTH_CODE",
    });
    assert.equal(token.accessToken, "SHORT_LIVED");
    assert.equal(token.expiresIn, 3600);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.ok(url.hostname === "graph.facebook.com");
    assert.equal(url.searchParams.get("client_id"), "APP_ID");
    assert.equal(url.searchParams.get("redirect_uri"), "https://app.example/api/meta/callback");
    assert.equal(url.searchParams.get("code"), "AUTH_CODE");
    assert.ok(url.searchParams.get("client_secret") === "APP_SECRET");
  });

  it("extends short-lived tokens via fb_exchange_token", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse({ access_token: "LONG_LIVED", token_type: "bearer", expires_in: 5184000 })
    );
    const client = new MetaGraphClient({ fetchImpl });
    const token = await client.exchangeForLongLivedToken({
      appId: "APP_ID",
      appSecret: "APP_SECRET",
      shortLivedToken: "SHORT_LIVED",
    });
    assert.equal(token.accessToken, "LONG_LIVED");
    assert.equal(token.expiresIn, 5184000);
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get("grant_type"), "fb_exchange_token");
    assert.equal(url.searchParams.get("fb_exchange_token"), "SHORT_LIVED");
  });

  it("inspects tokens and validates profiles", async () => {
    const debugFetch = mockFetch(() =>
      jsonResponse({
        data: {
          app_id: "APP_ID",
          user_id: "META_USER_1",
          scopes: ["leads_retrieval", "pages_show_list"],
          expires_at: 1893456000,
          is_valid: true,
        },
      })
    );
    const debug = await new MetaGraphClient({ fetchImpl: debugFetch.fetchImpl }).debugToken({
      appId: "APP_ID",
      appSecret: "APP_SECRET",
      inputToken: "USER_TOKEN",
    });
    assert.equal(debug.appId, "APP_ID");
    assert.equal(debug.userId, "META_USER_1");
    assert.deepEqual(debug.scopes, ["leads_retrieval", "pages_show_list"]);
    assert.equal(debug.expiresAt, 1893456000);

    const profileFetch = mockFetch(() => jsonResponse({ id: "META_USER_1", name: "Amena Begum" }));
    const profile = await new MetaGraphClient({ fetchImpl: profileFetch.fetchImpl }).getProfile("USER_TOKEN");
    assert.deepEqual(profile, { id: "META_USER_1", name: "Amena Begum" });
  });

  it("rejects invalid tokens and maps Meta errors without leaking tokens", async () => {
    const secretToken = "EAA-never-in-errors-12345";
    const invalidFetch = mockFetch(() => jsonResponse({ data: { is_valid: false } }));
    await assert.rejects(
      new MetaGraphClient({ fetchImpl: invalidFetch.fetchImpl }).debugToken({
        appId: "APP_ID",
        appSecret: "APP_SECRET",
        inputToken: secretToken,
      }),
      (err) => {
        assert.ok(err instanceof MetaApiError);
        assert.ok(!err.message.includes(secretToken));
        return true;
      }
    );

    const errorFetch = mockFetch(() =>
      jsonResponse({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }, 400)
    );
    await assert.rejects(
      new MetaGraphClient({ fetchImpl: errorFetch.fetchImpl }).getProfile(secretToken),
      (err) => {
        assert.ok(err instanceof MetaApiError);
        assert.equal(err.message, "Invalid OAuth access token.");
        assert.equal(err.code, 190);
        return true;
      }
    );

    const downFetch = mockFetch(() => {
      throw new Error("socket hang up");
    });
    await assert.rejects(
      new MetaGraphClient({ fetchImpl: downFetch.fetchImpl }).getProfile(secretToken),
      (err) => {
        assert.ok(!String(err.message).includes(secretToken));
        return true;
      }
    );
  });

  it("revokes with DELETE and surfaces failures", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse({ success: true }));
    await new MetaGraphClient({ fetchImpl }).revokePermissions("USER_TOKEN");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init?.method, "DELETE");
    assert.ok(new URL(calls[0].url).pathname.endsWith("/me/permissions"));

    const failing = mockFetch(() => jsonResponse({ error: { message: "Nope.", code: 1 } }, 400));
    await assert.rejects(new MetaGraphClient({ fetchImpl: failing.fetchImpl }).revokePermissions("T"), MetaApiError);
  });

  it("requests the documented Lead Ads scopes", () => {
    for (const scope of ["pages_show_list", "pages_read_engagement", "pages_manage_metadata", "ads_management", "leads_retrieval"]) {
      assert.ok(META_LEAD_SCOPES.includes(scope), `missing scope ${scope}`);
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP tests: route auth/tenant gating, redacted status, disconnect.
// The Graph API is never touched here.
// ---------------------------------------------------------------------------

const ROOT = path.join(import.meta.dirname, "..");
const FALLBACK_PORT = 8098;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `meta${Date.now()}`;
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
  return `10.91.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
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

/** Seed an encrypted connection row directly (bypasses Meta entirely). */
async function seedConnection({ businessId, metaUserName, token }) {
  const keyRaw = loadDotEnv().META_TOKEN_KEY;
  assert.ok(keyRaw, "META_TOKEN_KEY missing in .env");
  const ciphertext = await encryptToken(token, keyRaw);
  const client = pg();
  await client.connect();
  try {
    const { randomUUID } = await import("node:crypto");
    await client.query(
      `INSERT INTO "MetaConnection"
        ("id", "businessId", "metaUserId", "metaUserName", "accessTokenEncrypted", "tokenExpiresAt", "scopes", "status", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', NOW())`,
      [
        randomUUID(),
        businessId,
        `meta-user-${RUN_TAG}`,
        metaUserName,
        ciphertext,
        new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString(),
        [...META_LEAD_SCOPES].join(" "),
      ]
    );
  } finally {
    await client.end();
  }
}

async function connectionCount(businessId) {
  const client = pg();
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM "MetaConnection" WHERE "businessId" = $1`, [
      businessId,
    ]);
    return rows[0].n;
  } finally {
    await client.end();
  }
}

describe("meta OAuth routes", () => {
  it("gates connect by session, membership, and manager role", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} connect-gate`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");

    // Unauthenticated.
    assert.equal((await api("GET", `/api/businesses/${biz.id}/meta/connect`)).status, 401);
    // Cross-tenant member of another business.
    const outsider = await registerAndLogin();
    await createBusiness(outsider.cookie, `${RUN_TAG} other`);
    assert.equal((await api("GET", `/api/businesses/${biz.id}/meta/connect`, { cookie: outsider.cookie })).status, 403);
    // SALES lacks businesses.update.
    assert.equal((await api("GET", `/api/businesses/${biz.id}/meta/connect`, { cookie: sales.cookie })).status, 403);
    // OWNER is redirected to the Meta dialog with the documented parameters.
    const res = await api("GET", `/api/businesses/${biz.id}/meta/connect`, { cookie: owner.cookie });
    assert.equal(res.status, 307);
    const location = res.headers.get("location") ?? "";
    assert.ok(location.startsWith("https://www.facebook.com/"), `unexpected dialog host: ${location}`);
    const url = new URL(location);
    assert.ok(url.pathname.includes("/dialog/oauth"));
    assert.equal(url.searchParams.get("response_type"), "code");
    for (const scope of META_LEAD_SCOPES) {
      assert.ok(
        (url.searchParams.get("scope") ?? "").split(",").includes(scope),
        `dialog scope missing ${scope}`
      );
    }
    assert.ok(url.searchParams.get("state"), "dialog state missing");
  });

  it("fails the callback closed without touching Meta", async () => {
    const owner = await registerAndLogin();
    await createBusiness(owner.cookie, `${RUN_TAG} callback`);

    // No code.
    let res = await getHtml(`/api/meta/callback?state=bogus`, owner.cookie);
    assert.ok([301, 302, 303, 307, 308].includes(res.status), `expected redirect, got ${res.status}`);
    assert.match(res.location ?? "", /meta=error/);
    // Meta-reported decline.
    res = await getHtml(`/api/meta/callback?error=access_denied`, owner.cookie);
    assert.match(res.location ?? "", /meta=error/);
    // Forged state never reaches the token exchange (no network use possible).
    res = await getHtml(`/api/meta/callback?code=whatever&state=forged-state-value`, owner.cookie);
    assert.match(res.location ?? "", /meta=error/);
    // Anonymous callback goes to login, never to an exchange.
    res = await getHtml(`/api/meta/callback?code=x&state=y`, undefined);
    assert.match(res.location ?? "", /\/login/);
  });

  it("serves redacted status and enforces disconnect rules", async () => {
    const owner = await registerAndLogin();
    const sales = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} status`);
    await invite(owner.cookie, biz.id, sales.email, "SALES");

    // Disconnected shape.
    const empty = await api("GET", `/api/businesses/${biz.id}/meta`, { cookie: owner.cookie });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { connected: false });

    // Seed an encrypted connection, then read status as SALES (read allowed).
    const secretToken = `EAA-seed-token-${RUN_TAG}`;
    const accountName = `Seed Account ${RUN_TAG}`;
    await seedConnection({ businessId: biz.id, metaUserName: accountName, token: secretToken });
    const status = await api("GET", `/api/businesses/${biz.id}/meta`, { cookie: sales.cookie });
    assert.equal(status.status, 200);
    assert.equal(status.json.connected, true);
    assert.equal(status.json.metaUserName, accountName);
    assert.ok(Array.isArray(status.json.scopes));
    assert.ok(status.json.scopes.includes("leads_retrieval"));
    // Redaction: no token material anywhere in the payload.
    const serialized = JSON.stringify(status.json);
    assert.ok(!serialized.includes(secretToken), "plaintext token leaked in status");
    assert.ok(!serialized.includes("accessToken"), "token field leaked in status");
    assert.ok(!serialized.includes("v1."), "ciphertext leaked in status");

    // SALES cannot disconnect; OWNER can; second disconnect is 404.
    assert.equal((await api("DELETE", `/api/businesses/${biz.id}/meta`, { cookie: sales.cookie })).status, 403);
    assert.equal(await connectionCount(biz.id), 1);
    assert.equal((await api("DELETE", `/api/businesses/${biz.id}/meta`, { cookie: owner.cookie })).status, 200);
    assert.equal(await connectionCount(biz.id), 0);
    assert.equal((await api("DELETE", `/api/businesses/${biz.id}/meta`, { cookie: owner.cookie })).status, 404);

    // Auth + tenant gating on status/disconnect.
    assert.equal((await api("GET", `/api/businesses/${biz.id}/meta`)).status, 401);
    const stranger = await registerAndLogin();
    await createBusiness(stranger.cookie, `${RUN_TAG} stranger`);
    assert.equal((await api("GET", `/api/businesses/${biz.id}/meta`, { cookie: stranger.cookie })).status, 403);
    assert.equal((await api("DELETE", `/api/businesses/${biz.id}/meta`, { cookie: stranger.cookie })).status, 403);
  });

  it("keeps connection data tenant-isolated in UI and API", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} iso-A`);
    const bizB = await createBusiness(b.cookie, `${RUN_TAG} iso-B`);
    const accountName = `Isolated Account ${RUN_TAG}`;
    await seedConnection({ businessId: bizA.id, metaUserName: accountName, token: `EAA-iso-${RUN_TAG}` });

    // B's status shows disconnected; A's shows the account.
    const statusB = await api("GET", `/api/businesses/${bizB.id}/meta`, { cookie: b.cookie });
    assert.deepEqual(statusB.json, { connected: false });
    const statusA = await api("GET", `/api/businesses/${bizA.id}/meta`, { cookie: a.cookie });
    assert.equal(statusA.json.metaUserName, accountName);

    // Settings page renders A's account to A only.
    const pageA = await getHtml(`/dashboard/settings/integrations?businessId=${bizA.id}`, a.cookie);
    assert.equal(pageA.status, 200);
    assert.ok(pageA.html.includes(accountName), "owner page missing account name");
    const pageB = await getHtml(`/dashboard/settings/integrations?businessId=${bizB.id}`, b.cookie);
    assert.equal(pageB.status, 200);
    assert.ok(!pageB.html.includes(accountName), "settings page leaked foreign account");
  });
});
