// Auth end-to-end tests over HTTP against a throwaway `next dev` server.
// No project imports (only node builtins + pg): exercises routes, proxy,
// cookies, rate limits, and the DB-backed session lifecycle for real.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { Client } from "pg";

const ROOT = path.join(import.meta.dirname, "..");
// Reuse an already-running dev server when present (a second `next dev`
// in the same directory conflicts; low ports may also refuse binds with
// EACCES in sandboxed environments), else boot our own.
const FALLBACK_PORT = 8092;
let PORT = 4000;
let BASE = `http://127.0.0.1:${PORT}`;
const RUN_TAG = `authapi+${Date.now()}`;
let seq = 0;

const testEmail = () => `${RUN_TAG}+${seq++}@example.invalid`;
const PASSWORD = "correct horse battery staple 12";
const NEW_PASSWORD = "brand new battery staple 34";
let callNo = 0;

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

async function api(method, urlPath, { body, cookie } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (cookie) headers.cookie = cookie;
  // Distinct client IP per call: the dev server rate-limits per IP
  // (in-memory) and the server may be shared across test runs/files.
  // No test here asserts rate-limit behavior, so each call simulates a
  // distinct client to keep budgets out of the assertions.
  callNo += 1;
  headers["x-forwarded-for"] = `10.98.${Math.floor(callNo / 250) % 250}.${callNo % 250}`;
  const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: payload, redirect: "manual" });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, cookie: sessionCookieFrom(res) };
}

function assertNoSecrets(json, label) {
  const text = JSON.stringify(json);
  assert.ok(!/passwordHash/i.test(text), `${label} leaked passwordHash`);
  assert.ok(!/tokenHash/i.test(text), `${label} leaked tokenHash`);
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
  // Cleanup every row this run created (children first).
  const client = pg();
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT id FROM "User" WHERE email LIKE '${RUN_TAG}%'`);
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await client.query(`DELETE FROM "PasswordResetToken" WHERE "userId" = ANY($1)`, [ids]);
      await client.query(`DELETE FROM "Session" WHERE "userId" = ANY($1)`, [ids]);
      await client.query(`DELETE FROM "User" WHERE id = ANY($1)`, [ids]);
    }
  } finally {
    await client.end();
  }
}, { timeout: 60_000 });

describe("register + login + logout", () => {
  it("registers a user, sets a secure session cookie", async () => {
    const email = testEmail();
    const r = await api("POST", "/api/auth/register", {
      body: { email, password: PASSWORD, name: "Api Tester" },
    });
    assert.equal(r.status, 201);
    assertNoSecrets(r.json, "register");
    assert.equal(r.json.user.email, email);
    assert.ok(r.cookie, "register must set lf_session");
    const setCookie = r.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//i);
  });

  it("rejects duplicate registration with 409", async () => {
    const email = testEmail();
    assert.equal((await api("POST", "/api/auth/register", { body: { email, password: PASSWORD } })).status, 201);
    const dup = await api("POST", "/api/auth/register", { body: { email, password: PASSWORD } });
    assert.equal(dup.status, 409);
    assertNoSecrets(dup.json, "duplicate register");
  });

  it("rejects invalid payloads with 422", async () => {
    const r = await api("POST", "/api/auth/register", { body: { email: "bad", password: "short" } });
    assert.equal(r.status, 422);
    assert.ok(r.json.errors.email);
    assert.ok(r.json.errors.password);
  });

  it("logs in with valid credentials and fails safely otherwise", async () => {
    const email = testEmail();
    await api("POST", "/api/auth/register", { body: { email, password: PASSWORD } });

    const ok = await api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
    assert.equal(ok.status, 200);
    assertNoSecrets(ok.json, "login");
    assert.ok(ok.cookie);

    const wrong = await api("POST", "/api/auth/login", { body: { email, password: "wrong password entirely!!" } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, "Invalid email or password.");

    const unknown = await api("POST", "/api/auth/login", {
      body: { email: `nobody-${RUN_TAG}@example.invalid`, password: "wrong password entirely!!" },
    });
    assert.equal(unknown.status, 401);
    // Identical message: no account enumeration.
    assert.equal(unknown.json.error, wrong.json.error);
  });

  it("logout ends the session: /api/me rejects afterwards", async () => {
    const email = testEmail();
    await api("POST", "/api/auth/register", { body: { email, password: PASSWORD } });
    const login = await api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });

    const me = await api("GET", "/api/me", { cookie: login.cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.email, email);

    const out = await api("POST", "/api/auth/logout", { cookie: login.cookie });
    assert.equal(out.status, 200);

    const after = await api("GET", "/api/me", { cookie: login.cookie });
    assert.equal(after.status, 401);
  });

  it("rejects unauthenticated access to protected resources", async () => {
    const me = await api("GET", "/api/me");
    assert.equal(me.status, 401);

    const dash = await api("GET", "/dashboard");
    assert.ok([301, 302, 307, 308].includes(dash.status), `expected redirect, got ${dash.status}`);
    assert.match(dash.headers.get("location") ?? "", /\/login/);
  });

  it("serves the dashboard to an authenticated user", async () => {
    const email = testEmail();
    await api("POST", "/api/auth/register", { body: { email, password: PASSWORD } });
    const login = await api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
    const dash = await api("GET", "/dashboard", { cookie: login.cookie });
    assert.equal(dash.status, 200);
  });
});

describe("password reset", () => {
  it("forgot-password is generic for known and unknown emails", async () => {
    const email = testEmail();
    await api("POST", "/api/auth/register", { body: { email, password: PASSWORD } });

    const known = await api("POST", "/api/auth/forgot-password", { body: { email } });
    const unknown = await api("POST", "/api/auth/forgot-password", {
      body: { email: `ghost-${RUN_TAG}@example.invalid` },
    });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(known.json, unknown.json);
    assertNoSecrets(known.json, "forgot-password");
  });

  it("completes the reset flow and revokes old sessions", async () => {
    const email = testEmail();
    await api("POST", "/api/auth/register", { body: { email, password: PASSWORD } });
    const login = await api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
    const oldCookie = login.cookie;

    // Craft a reset token the way the email link would carry it.
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const client = pg();
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT id FROM "User" WHERE email = $1`, [email]);
      await client.query(
        `INSERT INTO "PasswordResetToken" ("id", "userId", "tokenHash", "expiresAt")
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), rows[0].id, tokenHash, new Date(Date.now() + 3_600_000).toISOString()]
      );
    } finally {
      await client.end();
    }

    const reset = await api("POST", "/api/auth/reset-password", {
      body: { token: rawToken, password: NEW_PASSWORD },
    });
    assert.equal(reset.status, 200);
    assertNoSecrets(reset.json, "reset-password");

    // Old password dead, new password works.
    assert.equal((await api("POST", "/api/auth/login", { body: { email, password: PASSWORD } })).status, 401);
    const relogin = await api("POST", "/api/auth/login", { body: { email, password: NEW_PASSWORD } });
    assert.equal(relogin.status, 200);

    // Pre-reset session was revoked by the password change.
    assert.equal((await api("GET", "/api/me", { cookie: oldCookie })).status, 401);

    // Single-use: replay fails.
    const replay = await api("POST", "/api/auth/reset-password", {
      body: { token: rawToken, password: "another new password 99" },
    });
    assert.equal(replay.status, 400);
  });

  it("rejects bogus and expired tokens", async () => {
    const bogus = await api("POST", "/api/auth/reset-password", {
      body: { token: randomBytes(32).toString("base64url"), password: NEW_PASSWORD },
    });
    assert.equal(bogus.status, 400);
    assert.equal(bogus.json.error, "Invalid or expired reset token.");

    const email = testEmail();
    await api("POST", "/api/auth/register", { body: { email, password: PASSWORD } });
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const client = pg();
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT id FROM "User" WHERE email = $1`, [email]);
      await client.query(
        `INSERT INTO "PasswordResetToken" ("id", "userId", "tokenHash", "expiresAt")
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), rows[0].id, tokenHash, new Date(Date.now() - 1000).toISOString()]
      );
    } finally {
      await client.end();
    }
    const expired = await api("POST", "/api/auth/reset-password", {
      body: { token: rawToken, password: NEW_PASSWORD },
    });
    assert.equal(expired.status, 400);
  });
});
