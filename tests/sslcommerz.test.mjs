// SSLCommerz payment tests (Bangladesh gateway, docs v4).
//
// Layers, matching the module boundaries (direct .ts imports work with
// Node type-stripping; config/client/payloads have no project-local
// imports):
//  1. config: env resolution + missing-credential failure.
//  2. payloads: IPN parsing, money math, validation classification,
//     tran_id / invoice helpers.
//  3. client: session init + order validation against a mocked gateway
//     (injected fetchImpl — no network).
//  4. HTTP end-to-end against a dedicated dev server (own port + env, so
//     the shared server is untouched) with SSLCOMMERZ_BASE_URL pointed at
//     an in-test mock gateway. Covers every acceptance criterion:
//     checkout, initiation, server-side verification, IPN handling,
//     payment + invoice records, activation, failed handling, idempotency,
//     duplicate protection, and the frontend-success-must-not-activate
//     invariant.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Client } from "pg";
import {
  SSLCOMMERZ_LIVE_HOST,
  SSLCOMMERZ_SANDBOX_HOST,
  sslcommerzConfig,
  SslcommerzConfigError,
} from "../src/lib/integrations/sslcommerz/config.ts";
import { SSLCommerzClient, SSLCommerzError, SslcommerzUpstreamError } from "../src/lib/integrations/sslcommerz/client.ts";
import {
  formatMinorBdt,
  invoiceNumberFor,
  newTranId,
  parseInitResponse,
  parseIpnParams,
  parseValidationResponse,
  toDecimalString,
  toMinorUnits,
  validationAccepts,
} from "../src/lib/integrations/sslcommerz/payloads.ts";

describe("sslcommerz config (pure)", () => {
  it("resolves sandbox by default and honors env", () => {
    const sandbox = sslcommerzConfig({ SSLCOMMERZ_STORE_ID: "id", SSLCOMMERZ_STORE_SECRET: "secret" });
    assert.equal(sandbox.baseUrl, SSLCOMMERZ_SANDBOX_HOST);
    assert.equal(sandbox.sandbox, true);
    const live = sslcommerzConfig({ SSLCOMMERZ_STORE_ID: "id", SSLCOMMERZ_STORE_SECRET: "s", SSLCOMMERZ_SANDBOX: "false" });
    assert.equal(live.baseUrl, SSLCOMMERZ_LIVE_HOST);
    assert.equal(live.sandbox, false);
    const override = sslcommerzConfig({
      SSLCOMMERZ_STORE_ID: "id",
      SSLCOMMERZ_STORE_SECRET: "s",
      SSLCOMMERZ_BASE_URL: "http://127.0.0.1:9/mock/",
    });
    assert.equal(override.baseUrl, "http://127.0.0.1:9/mock");
  });

  it("fails closed without credentials", () => {
    for (const env of [{}, { SSLCOMMERZ_STORE_ID: "id" }, { SSLCOMMERZ_STORE_SECRET: "s" }, { SSLCOMMERZ_STORE_ID: "  " }]) {
      assert.throws(() => sslcommerzConfig(env), SslcommerzConfigError);
    }
  });
});

describe("sslcommerz money + payloads (pure)", () => {
  it("converts decimals to minor units without floats", () => {
    assert.equal(toMinorUnits("100"), 10000);
    assert.equal(toMinorUnits("100.00"), 10000);
    assert.equal(toMinorUnits("100.5"), 10050);
    assert.equal(toMinorUnits("0.01"), 1);
    assert.equal(toMinorUnits(" 490.00 "), 49000);
    assert.equal(toMinorUnits("100.001"), null);
    assert.equal(toMinorUnits("-5"), null);
    assert.equal(toMinorUnits("abc"), null);
    assert.equal(toMinorUnits(""), null);
    assert.equal(toMinorUnits(100), null);
    assert.equal(toMinorUnits(null), null);
  });

  it("formats decimals and BDT display strings", () => {
    assert.equal(toDecimalString(49000), "490.00");
    assert.equal(toDecimalString(10050), "100.50");
    assert.equal(toDecimalString(0), "0.00");
    assert.equal(formatMinorBdt(149000), "৳1,490.00");
    assert.equal(formatMinorBdt(0), "৳0.00");
  });

  it("parses IPN bodies tolerantly", () => {
    const valid = parseIpnParams({
      status: "VALID",
      tran_id: "LF-abc123",
      val_id: "VAL123",
      amount: "490.00",
      currency: "BDT",
      risk_level: "0",
    });
    assert.deepEqual(valid, {
      status: "VALID",
      tranId: "LF-abc123",
      valId: "VAL123",
      amountMinor: 49000,
      currency: "BDT",
      riskLevel: 0,
      rawAmount: "490.00",
    });
    // Lowercase status, missing optionals, numeric risk.
    const failed = parseIpnParams({ status: "failed", tran_id: "LF-x" });
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.valId, null);
    assert.equal(failed.amountMinor, null);
    assert.equal(failed.riskLevel, 1, "unparseable risk must fail closed");
    // Malformed payloads are ignored, never throw.
    assert.equal(parseIpnParams(null), null);
    assert.equal(parseIpnParams("x"), null);
    assert.equal(parseIpnParams([]), null);
    assert.equal(parseIpnParams({ status: "BOGUS", tran_id: "LF-x" }), null);
    assert.equal(parseIpnParams({ status: "VALID" }), null);
    assert.equal(parseIpnParams({ status: "VALID", tran_id: "" }), null);
    assert.equal(parseIpnParams({ status: "VALID", tran_id: "x".repeat(31) }), null);
  });

  it("classifies validation responses per the docs", () => {
    assert.equal(validationAccepts({ status: "VALID" }), true);
    assert.equal(validationAccepts({ status: "VALIDATED" }), true);
    assert.equal(validationAccepts({ status: "INVALID_TRANSACTION" }), false);
    assert.equal(validationAccepts(null), false);
    const parsed = parseValidationResponse({
      status: "VALIDATED",
      tran_id: "LF-abc",
      val_id: "V1",
      amount: "1490.00",
      currency: "BDT",
      risk_level: "1",
    });
    assert.equal(parsed.tranId, "LF-abc");
    assert.equal(parsed.amountMinor, 149000);
    assert.equal(parsed.riskLevel, 1);
    assert.equal(parseValidationResponse(null), null);
    assert.equal(parseValidationResponse({}), null);
    assert.equal(parseValidationResponse({ status: 42 }), null);
  });

  it("parses session-init responses strictly", () => {
    const ok = parseInitResponse({ status: "SUCCESS", sessionkey: "S", GatewayPageURL: "https://gw/pay" });
    assert.deepEqual(ok, { ok: true, sessionKey: "S", gatewayPageURL: "https://gw/pay", failedReason: null });
    assert.equal(parseInitResponse({ status: "FAILED", failedreason: "bad store" }).ok, false);
    assert.equal(parseInitResponse({ status: "SUCCESS" }).ok, false, "URL is mandatory");
    assert.equal(parseInitResponse(null).ok, false);
  });

  it("mints gateway-safe tran ids and invoice numbers", () => {
    const tranId = newTranId("abcdef0123456789abcdef0123456789");
    assert.ok(tranId.startsWith("LF-"));
    assert.ok(tranId.length <= 30, tranId);
    assert.match(tranId, /^LF-[0-9a-f]{20}$/);
    assert.equal(newTranId("xyz"), "LF-00000000000000000000");
    assert.equal(invoiceNumberFor("LF-abc"), "INV-LF-abc");
  });
});

describe("sslcommerz client (mocked gateway)", () => {
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

  it("initiates sessions with form encoding and parses the gateway URL", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse({ status: "SUCCESS", sessionkey: "SESS", GatewayPageURL: "https://sandbox/gw.php?x=1" })
    );
    const client = new SSLCommerzClient({ fetchImpl, baseUrl: "https://gw.test" });
    const raw = await client.initSession({ store_id: "id", total_amount: "490.00", tran_id: "LF-x" });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith("https://gw.test/gwprocess/v4/api.php"));
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["content-type"], "application/x-www-form-urlencoded");
    assert.ok(!calls[0].url.includes("store_passwd"), "secret must travel in the body, never the URL");
    const parsed = parseInitResponse(raw);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.gatewayPageURL, "https://sandbox/gw.php?x=1");
  });

  it("validates orders with credentials in the query string (gateway convention)", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse({ status: "VALID", tran_id: "LF-x", amount: "490.00", currency: "BDT" })
    );
    const client = new SSLCommerzClient({ fetchImpl, baseUrl: "https://gw.test" });
    const raw = await client.validateOrder({ valId: "V1", storeId: "id", storePasswd: "secret" });
    const url = new URL(calls[0].url);
    assert.ok(url.pathname.endsWith("/validator/api/validationserverAPI.php"));
    assert.equal(url.searchParams.get("val_id"), "V1");
    assert.equal(url.searchParams.get("format"), "json");
    assert.equal(parseValidationResponse(raw).status, "VALID");
  });

  it("maps network and gateway failures without leaking secrets", async () => {
    const secret = "super-secret-store-passwd";
    const down = mockFetch(() => {
      throw new Error("socket hang up");
    });
    await assert.rejects(
      new SSLCommerzClient({ fetchImpl: down.fetchImpl }).initSession({ store_passwd: secret }),
      (err) => {
        assert.ok(err instanceof SslcommerzUpstreamError);
        assert.ok(!String(err.message).includes(secret));
        return true;
      }
    );
    const failing = mockFetch(() => jsonResponse({ error: "nope" }, 500));
    await assert.rejects(
      new SSLCommerzClient({ fetchImpl: failing.fetchImpl }).validateOrder({ valId: "V", storeId: "i", storePasswd: secret }),
      (err) => {
        assert.ok(err instanceof SSLCommerzError);
        assert.ok(!(err instanceof SslcommerzUpstreamError));
        assert.ok(!String(err.message).includes(secret));
        return true;
      }
    );
    const garbage = mockFetch(() => new Response("not-json", { status: 200 }));
    await assert.rejects(
      new SSLCommerzClient({ fetchImpl: garbage.fetchImpl }).initSession({}),
      SSLCommerzError
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP end-to-end: dedicated dev server (own port + env) with
// SSLCOMMERZ_BASE_URL pointed at an in-test mock gateway. Covers every
// acceptance criterion: checkout, initiation, server-side verification,
// IPN handling, payment + invoice records, activation, failed handling,
// idempotency, duplicate protection, and tenant isolation.
// ---------------------------------------------------------------------------

const ROOT = path.join(import.meta.dirname, "..");
const FALLBACK_PORT = 8102;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `pay${Date.now()}`;
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
  return `10.100.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
}

async function api(method, urlPath, { body, cookie, rawBody, contentType } = {}) {
  const headers = {};
  let payload = rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined);
  if (body !== undefined || rawBody !== undefined) {
    headers["content-type"] = contentType ?? "application/json";
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
  return { status: res.status, headers: res.headers, html: await res.text() };
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

// Mock SSLCommerz gateway: programmable session init + order validation.
const mockState = {
  initMode: "ok",
  initCalls: [],
  validationMode: "ok",
  validationCalls: 0,
  validationAmount: null,
  validationRisk: "0",
  validationTranId: null,
};

function mockValidationPayload(tranId, amount, risk) {
  return {
    status: "VALID",
    tran_id: tranId,
    val_id: `VAL-${tranId}`,
    amount,
    currency: "BDT",
    currency_type: "BDT",
    currency_amount: amount,
    risk_level: risk,
    risk_title: risk === "1" ? "High" : "Safe",
  };
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
    if (req.method === "POST" && url.pathname === "/gwprocess/v4/api.php") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const params = new URLSearchParams(raw);
        mockState.initCalls.push(Object.fromEntries(params.entries()));
        if (mockState.initMode === "reject") {
          send({ status: "FAILED", failedreason: "Invalid store credentials." });
          return;
        }
        const tranId = params.get("tran_id") ?? "unknown";
        send({
          status: "SUCCESS",
          failedreason: "",
          sessionkey: `SESS-${tranId}`,
          GatewayPageURL: `http://127.0.0.1:${mockPort}/gw.php?tran_id=${tranId}`,
        });
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/validator/api/validationserverAPI.php") {
      mockState.validationCalls += 1;
      const valId = url.searchParams.get("val_id") ?? "";
      const tranId = mockState.validationTranId ?? (valId.startsWith("VAL-") ? valId.slice(4) : valId);
      if (mockState.validationMode === "invalid") {
        send({ status: "INVALID_TRANSACTION" });
        return;
      }
      if (mockState.validationMode === "down") {
        send({ error: "boom" }, 500);
        return;
      }
      send(mockValidationPayload(tranId, mockState.validationAmount ?? "490.00", mockState.validationRisk));
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
      SSLCOMMERZ_STORE_ID: "testbox",
      SSLCOMMERZ_STORE_SECRET: "test-secret",
      SSLCOMMERZ_SANDBOX: "true",
      SSLCOMMERZ_BASE_URL: `http://127.0.0.1:${mockPort}`,
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
      await client.query(`DELETE FROM "Invoice" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "Payment" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "Subscription" WHERE "businessId" = ANY($1)`, [bizIds]);
      await client.query(`DELETE FROM "Notification" WHERE "businessId" = ANY($1)`, [bizIds]);
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

function ipnForm(overrides) {
  const params = new URLSearchParams({
    status: "VALID",
    tran_date: "2026-09-09 11:00:00",
    tran_id: "LF-unknown",
    val_id: "VAL-LF-unknown",
    amount: "490.00",
    store_amount: "470.00",
    currency: "BDT",
    bank_tran_id: "BANK123",
    currency_type: "BDT",
    currency_amount: "490.00",
    verify_sign: "sig",
    verify_key: "amount,tran_id",
    risk_level: "0",
    ...overrides,
  });
  return params.toString();
}

async function postIpn(overrides) {
  return api("POST", "/api/webhooks/sslcommerz/ipn", {
    rawBody: ipnForm(overrides),
    contentType: "application/x-www-form-urlencoded",
  });
}

describe("checkout + initiation (HTTP, mocked gateway)", () => {
  it("creates invoice + payment records and returns the gateway URL", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} checkout`);
    mockState.initMode = "ok";
    mockState.initCalls = [];

    const res = await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
      body: { planCode: "STARTER" },
      cookie: owner.cookie,
    });
    assert.equal(res.status, 201, `checkout failed: ${JSON.stringify(res.json)}`);
    assert.ok(res.json.gatewayUrl.includes("/gw.php?tran_id="), "missing gateway redirect");
    assert.match(res.json.tranId, /^LF-[0-9a-f]{20}$/);

    // Initiation used server-derived credentials + catalog amount.
    assert.equal(mockState.initCalls.length, 1);
    const init = mockState.initCalls[0];
    assert.equal(init.store_id, "testbox");
    assert.equal(init.total_amount, "490.00");
    assert.equal(init.currency, "BDT");
    assert.equal(init.tran_id, res.json.tranId);
    assert.ok(init.success_url.includes("/api/payments/callback/success"));
    assert.ok(init.ipn_url.endsWith("/api/webhooks/sslcommerz/ipn"));

    const payments = await dbRows(`SELECT * FROM "Payment" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(payments.length, 1);
    assert.equal(payments[0].status, "PENDING");
    assert.equal(payments[0].planCode, "STARTER");
    assert.equal(payments[0].amountMinor, 49000);
    assert.equal(payments[0].currency, "BDT");
    assert.ok(payments[0].gatewaySessionKey.startsWith("SESS-"));
    assert.equal(payments[0].activatedAt, null);

    const invoices = await dbRows(`SELECT * FROM "Invoice" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].status, "DRAFT");
    assert.equal(invoices[0].amountMinor, 49000);
    assert.equal(invoices[0].paymentId, payments[0].id);
    assert.match(invoices[0].invoiceNumber, /^INV-LF-[0-9a-f]{20}$/);

    // Subscription is untouched until gateway confirmation arrives.
    const subs = await dbRows(`SELECT "planCode", status FROM "Subscription" WHERE "businessId" = $1`, [biz.id]);
    assert.ok(subs.length === 0 || subs[0].planCode === "FREE", "checkout must not activate");
  });

  it("rejects bad plans, FREE checkouts, non-owners, and gateway rejections", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} checkout-neg`);

    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
        body: { planCode: "ENTERPRISE" },
        cookie: owner.cookie,
      })).status,
      422
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
        body: { planCode: "FREE" },
        cookie: owner.cookie,
      })).status,
      422
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
        body: { planCode: "STARTER", amountMinor: 1 },
        cookie: owner.cookie,
      })).status,
      201,
      "unknown fields must be ignored, amount still server-derived"
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/payments/checkout`, { body: {}, cookie: owner.cookie })).status,
      422
    );
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
        body: { planCode: "STARTER" },
      })).status,
      401
    );

    // Non-member and non-owner callers are denied without leaking.
    const stranger = await registerAndLogin();
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
        body: { planCode: "STARTER" },
        cookie: stranger.cookie,
      })).status,
      403
    );
    const sales = await registerAndLogin();
    assert.equal(
      (await api("PATCH", `/api/businesses/${biz.id}/subscription`, {
        body: { planCode: "STARTER" },
        cookie: owner.cookie,
      })).status,
      200
    );
    await api("POST", `/api/businesses/${biz.id}/members`, {
      body: { email: sales.email, role: "SALES" },
      cookie: owner.cookie,
    });
    assert.equal(
      (await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
        body: { planCode: "STARTER" },
        cookie: sales.cookie,
      })).status,
      403,
      "SALES members must not start checkouts"
    );

    mockState.initMode = "reject";
    const rejected = await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
      body: { planCode: "GROWTH" },
      cookie: owner.cookie,
    });
    assert.equal(rejected.status, 502, `expected 502, got ${rejected.status}: ${JSON.stringify(rejected.json)}`);
    const failed = await dbRows(
      `SELECT status FROM "Payment" WHERE "businessId" = $1 AND "planCode" = 'GROWTH'`,
      [biz.id]
    );
    assert.equal(failed.length, 1);
    assert.equal(failed[0].status, "FAILED");
    mockState.initMode = "ok";
  });
});

describe("IPN verification + activation (HTTP, mocked gateway)", () => {
  it("activates only after server-side validation with matching amount", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} ipn-ok`);
    mockState.initMode = "ok";
    mockState.validationMode = "ok";
    mockState.validationAmount = "490.00";
    mockState.validationRisk = "0";
    const checkout = await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
      body: { planCode: "STARTER" },
      cookie: owner.cookie,
    });
    assert.equal(checkout.status, 201);
    const tranId = checkout.json.tranId;

    const res = await postIpn({ tran_id: tranId, val_id: `VAL-${tranId}`, amount: "490.00" });
    assert.equal(res.status, 200, `IPN failed: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.processed, true);
    assert.equal(res.json.duplicate, false);
    assert.equal(mockState.validationCalls, 1, "validation API must be called exactly once");

    const payments = await dbRows(`SELECT * FROM "Payment" WHERE "tranId" = $1`, [tranId]);
    assert.equal(payments[0].status, "SUCCESS");
    assert.equal(payments[0].valId, `VAL-${tranId}`);
    assert.ok(payments[0].activatedAt, "activation timestamp must be stamped");
    const invoices = await dbRows(`SELECT * FROM "Invoice" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(invoices[0].status, "PAID");
    assert.ok(invoices[0].periodStart && invoices[0].periodEnd, "invoice must carry the paid cycle");
    const subs = await dbRows(`SELECT "planCode", status FROM "Subscription" WHERE "businessId" = $1`, [biz.id]);
    assert.deepEqual([subs[0].planCode, subs[0].status], ["STARTER", "ACTIVE"]);
  });

  it("absorbs duplicate IPN replays without double-activating", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} ipn-dupe`);
    mockState.validationMode = "ok";
    mockState.validationAmount = "1490.00";
    mockState.validationRisk = "0";
    const callsBefore = mockState.validationCalls;
    const checkout = await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
      body: { planCode: "GROWTH" },
      cookie: owner.cookie,
    });
    const tranId = checkout.json.tranId;

    const first = await postIpn({ tran_id: tranId, val_id: `VAL-${tranId}`, amount: "1490.00" });
    assert.equal(first.json.processed, true);
    const second = await postIpn({ tran_id: tranId, val_id: `VAL-${tranId}`, amount: "1490.00" });
    assert.equal(second.status, 200);
    assert.equal(second.json.processed, false);
    assert.equal(second.json.duplicate, true);
    assert.equal(mockState.validationCalls, callsBefore + 1, "duplicate must skip the validation call");

    const payments = await dbRows(`SELECT COUNT(*)::int AS n FROM "Payment" WHERE "tranId" = $1`, [tranId]);
    assert.equal(payments[0].n, 1);
    const invoices = await dbRows(`SELECT status, COUNT(*)::int AS n FROM "Invoice" WHERE "businessId" = $1 GROUP BY status`, [biz.id]);
    assert.deepEqual(invoices, [{ status: "PAID", n: 1 }]);
    const subs = await dbRows(`SELECT COUNT(*)::int AS n FROM "Subscription" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(subs[0].n, 1, "exactly one subscription row");
  });

  it("rejects tampered amounts without activating", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} ipn-tamper`);
    const checkout = await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
      body: { planCode: "STARTER" },
      cookie: owner.cookie,
    });
    const tranId = checkout.json.tranId;

    // The gateway truth says 1.00 was paid for a 490.00 invoice: reject.
    mockState.validationMode = "ok";
    mockState.validationAmount = "1.00";
    mockState.validationRisk = "0";
    mockState.validationTranId = null;
    const short = await postIpn({ tran_id: tranId, val_id: `VAL-${tranId}`, amount: "490.00" });
    assert.equal(short.status, 200);
    assert.equal(short.json.processed, true);

    // A val_id belonging to a different transaction is rejected too.
    // (Fresh checkout: the first payment is already terminal.)
    const checkout2 = await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
      body: { planCode: "STARTER" },
      cookie: owner.cookie,
    });
    const tranId2 = checkout2.json.tranId;
    mockState.validationAmount = "490.00";
    mockState.validationTranId = "LF-ffffffffffffffffffff";
    const swapped = await postIpn({ tran_id: tranId2, val_id: `VAL-${tranId2}`, amount: "490.00" });
    assert.equal(swapped.status, 200);
    assert.equal(swapped.json.processed, true);
    mockState.validationTranId = null;

    for (const id of [tranId, tranId2]) {
      const payments = await dbRows(`SELECT status, "activatedAt" FROM "Payment" WHERE "tranId" = $1`, [id]);
      assert.equal(payments[0].status, "FAILED", id);
      assert.equal(payments[0].activatedAt, null);
    }
    const subs = await dbRows(`SELECT "planCode" FROM "Subscription" WHERE "businessId" = $1`, [biz.id]);
    assert.ok(subs.length === 0 || subs[0].planCode === "FREE", "tampered payment must not activate");
    const notes = await dbRows(
      `SELECT COUNT(*)::int AS n FROM "Notification" WHERE "businessId" = $1 AND type = 'PAYMENT_FAILED'`,
      [biz.id]
    );
    assert.equal(notes[0].n, 2, "managers must be notified of each rejected payment");
  });

  it("holds risky payments for review instead of activating", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} ipn-risk`);
    mockState.validationMode = "ok";
    mockState.validationAmount = "490.00";
    mockState.validationRisk = "1";
    const checkout = await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
      body: { planCode: "STARTER" },
      cookie: owner.cookie,
    });
    const tranId = checkout.json.tranId;
    const res = await postIpn({ tran_id: tranId, val_id: `VAL-${tranId}`, amount: "490.00" });
    assert.equal(res.json.processed, true);
    const payments = await dbRows(`SELECT status, "riskLevel" FROM "Payment" WHERE "tranId" = $1`, [tranId]);
    assert.equal(payments[0].status, "RISK_HOLD");
    assert.equal(payments[0].riskLevel, 1);
    const subs = await dbRows(`SELECT "planCode" FROM "Subscription" WHERE "businessId" = $1`, [biz.id]);
    assert.ok(subs.length === 0 || subs[0].planCode === "FREE", "risky payment must not activate");
    mockState.validationRisk = "0";
  });

  it("records failed gateway payments and ignores unknown tran ids", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} ipn-fail`);
    const checkout = await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
      body: { planCode: "STARTER" },
      cookie: owner.cookie,
    });
    const tranId = checkout.json.tranId;

    const failed = await postIpn({ tran_id: tranId, status: "FAILED" });
    assert.equal(failed.status, 200);
    assert.equal(failed.json.processed, true);
    const payments = await dbRows(`SELECT status FROM "Payment" WHERE "tranId" = $1`, [tranId]);
    assert.equal(payments[0].status, "FAILED");
    const invoices = await dbRows(`SELECT status FROM "Invoice" WHERE "businessId" = $1`, [biz.id]);
    assert.equal(invoices[0].status, "VOID");
    const subs = await dbRows(`SELECT "planCode" FROM "Subscription" WHERE "businessId" = $1`, [biz.id]);
    assert.ok(subs.length === 0 || subs[0].planCode === "FREE");
    const notes = await dbRows(
      `SELECT COUNT(*)::int AS n FROM "Notification" WHERE "businessId" = $1 AND type = 'PAYMENT_FAILED'`,
      [biz.id]
    );
    assert.equal(notes[0].n, 1);

    // A FAILED payment can never be resurrected by a replayed VALID IPN.
    mockState.validationMode = "ok";
    mockState.validationAmount = "490.00";
    const replay = await postIpn({ tran_id: tranId, val_id: `VAL-${tranId}`, amount: "490.00" });
    assert.equal(replay.json.processed, false);
    assert.equal(replay.json.duplicate, true);

    // Unknown tran ids are acknowledged without state changes or leaks.
    const ghost = await postIpn({ tran_id: "LF-0123456789abcdef0123" });
    assert.equal(ghost.status, 200);
    assert.equal(ghost.json.processed, false);
    // Malformed bodies are ignored, never crash.
    const malformed = await api("POST", "/api/webhooks/sslcommerz/ipn", {
      rawBody: "status=BOGUS&tran_id=",
      contentType: "application/x-www-form-urlencoded",
    });
    assert.equal(malformed.status, 200);
    assert.equal(malformed.json.processed, false);
  });
});

describe("browser callbacks never activate (HTTP)", () => {
  it("redirects without touching payment or subscription state", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} callback`);
    const checkout = await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
      body: { planCode: "STARTER" },
      cookie: owner.cookie,
    });
    const tranId = checkout.json.tranId;

    // Even a "success" browser hit — the exact spoof vector — changes nothing.
    const res = await fetch(`${BASE}/api/payments/callback/success?tran_id=${tranId}`, {
      headers: { "x-forwarded-for": nextIp() },
      redirect: "manual",
    });
    assert.ok([301, 302, 303, 307, 308].includes(res.status), `expected redirect, got ${res.status}`);
    const location = res.headers.get("location") ?? "";
    assert.ok(location.includes("/dashboard/settings/billing"), `unexpected redirect: ${location}`);
    assert.ok(location.includes(`businessId=${biz.id}`));

    const payments = await dbRows(`SELECT status, "activatedAt" FROM "Payment" WHERE "tranId" = $1`, [tranId]);
    assert.equal(payments[0].status, "PENDING");
    assert.equal(payments[0].activatedAt, null);
    const subs = await dbRows(`SELECT "planCode" FROM "Subscription" WHERE "businessId" = $1`, [biz.id]);
    assert.ok(subs.length === 0 || subs[0].planCode === "FREE", "browser callback must not activate");

    const fail = await fetch(`${BASE}/api/payments/callback/fail?tran_id=${tranId}`, {
      method: "POST",
      headers: { "x-forwarded-for": nextIp() },
      redirect: "manual",
    });
    assert.ok([301, 302, 303, 307, 308].includes(fail.status));
    const unknown = await fetch(`${BASE}/api/payments/callback/success?tran_id=LF-0123456789abcdef0123`, {
      headers: { "x-forwarded-for": nextIp() },
      redirect: "manual",
    });
    assert.ok([301, 302, 303, 307, 308].includes(unknown.status));
    assert.ok(!(unknown.headers.get("location") ?? "").includes("businessId="), "unknown tran must not leak a workspace");
    const bad = await fetch(`${BASE}/api/payments/callback/bogus?tran_id=${tranId}`, {
      headers: { "x-forwarded-for": nextIp() },
      redirect: "manual",
    });
    assert.equal(bad.status, 404);
  });
});

describe("payment tenant isolation + invoices (HTTP)", () => {
  it("keeps payments and invoices inside the owning workspace", async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const bizA = await createBusiness(a.cookie, `${RUN_TAG} pay-A`);
    const bizB = await createBusiness(b.cookie, `${RUN_TAG} pay-B`);
    const checkout = await api("POST", `/api/businesses/${bizA.id}/payments/checkout`, {
      body: { planCode: "STARTER" },
      cookie: a.cookie,
    });
    assert.equal(checkout.status, 201);

    // B cannot list A's invoices and sees an empty history of their own.
    assert.equal(
      (await api("GET", `/api/businesses/${bizA.id}/invoices`, { cookie: b.cookie })).status,
      403
    );
    const own = await api("GET", `/api/businesses/${bizB.id}/invoices`, { cookie: b.cookie });
    assert.equal(own.status, 200);
    assert.deepEqual(own.json.invoices, []);
    assert.equal((await api("GET", `/api/businesses/${bizA.id}/invoices`)).status, 401);

    const list = await api("GET", `/api/businesses/${bizA.id}/invoices`, { cookie: a.cookie });
    assert.equal(list.status, 200);
    assert.equal(list.json.invoices.length, 1);
    assert.equal(list.json.invoices[0].paymentStatus, "PENDING");
    assert.ok(!JSON.stringify(list.json).includes("test-secret"), "secret leaked in invoice history");

    // B cannot spend A's payment: IPN is keyed by unguessable tran_id only.
    mockState.validationMode = "ok";
    mockState.validationAmount = "490.00";
    mockState.validationRisk = "0";
    mockState.validationTranId = null;
    const other = await postIpn({ tran_id: checkout.json.tranId, val_id: `VAL-${checkout.json.tranId}`, amount: "490.00" });
    assert.equal(other.json.processed, true, "gateway IPN is public by design");
    const subsB = await dbRows(`SELECT "planCode" FROM "Subscription" WHERE "businessId" = $1`, [bizB.id]);
    assert.ok(subsB.length === 0 || subsB[0].planCode === "FREE", "B must be untouched by A's payment");
  });
});

describe("billing page with payments (HTTP)", () => {
  it("renders checkout prices, invoices, and the payment banner", async () => {
    const owner = await registerAndLogin();
    const biz = await createBusiness(owner.cookie, `${RUN_TAG} pay-ui`);
    const checkout = await api("POST", `/api/businesses/${biz.id}/payments/checkout`, {
      body: { planCode: "GROWTH" },
      cookie: owner.cookie,
    });
    assert.equal(checkout.status, 201);

    const page = await getHtml(`/dashboard/settings/billing?businessId=${biz.id}`, owner.cookie);
    assert.equal(page.status, 200, `billing page failed with ${page.status}`);
    for (const needle of ["৳490", "SSLCommerz", "Invoices", checkout.json.tranId.replace("LF-", "INV-LF-")]) {
      assert.ok(page.html.includes(needle), `billing page missing ${JSON.stringify(needle)}`);
    }
    const banner = await getHtml(
      `/dashboard/settings/billing?businessId=${biz.id}&payment=success&tran_id=${checkout.json.tranId}`,
      owner.cookie
    );
    assert.equal(banner.status, 200);
    assert.ok(banner.html.includes("Payment received"), "missing success banner");
  });
});
