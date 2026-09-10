// Auth unit tests: pure libs only (explicit .ts entry imports work with
// Node type-stripping; these modules have no project-local imports).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, dummyVerify } from "../src/lib/auth/password.ts";
import {
  validateRegister,
  validateLogin,
  validateForgotPassword,
  validateResetPassword,
  normalizeEmail,
} from "../src/lib/auth/validation.ts";
import { RateLimiter } from "../src/lib/auth/rate-limit.ts";

describe("password hashing (scrypt)", () => {
  it("hashes and verifies the same password", async () => {
    const hash = await hashPassword("correct horse battery staple 12");
    assert.match(hash, /^scrypt\$/);
    assert.equal(await verifyPassword("correct horse battery staple 12", hash), true);
  });

  it("rejects wrong passwords and malformed hashes without throwing", async () => {
    const hash = await hashPassword("another valid password 99");
    assert.equal(await verifyPassword("wrong password at all!!", hash), false);
    assert.equal(await verifyPassword("x", "not-a-hash"), false);
    assert.equal(await verifyPassword("x", "scrypt$v=1$n=999999999$r=8$p=1$AAAA$BBBB"), false);
  });

  it("salts uniquely: same password gives different hashes", async () => {
    const a = await hashPassword("same password here 1234");
    const b = await hashPassword("same password here 1234");
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("same password here 1234", a), true);
    assert.equal(await verifyPassword("same password here 1234", b), true);
  });

  it("dummyVerify resolves (timing-equalized unknown-account path)", async () => {
    await dummyVerify("whatever password 12345");
  });
});

describe("input validation", () => {
  it("accepts a valid registration payload", () => {
    const r = validateRegister({ email: "  User@Example.COM ", password: "long enough password 1", name: " A " });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { email: "user@example.com", password: "long enough password 1", name: "A" });
  });

  it("rejects bad email, short password, long name", () => {
    const r = validateRegister({ email: "not-an-email", password: "short", name: "x".repeat(101) });
    assert.equal(r.ok, false);
    assert.ok(r.errors.email);
    assert.ok(r.errors.password);
    assert.ok(r.errors.name);
  });

  it("rejects non-object bodies", () => {
    assert.equal(validateRegister(null).ok, false);
    assert.equal(validateLogin("nope").ok, false);
  });

  it("login requires a non-empty password but reveals nothing else", () => {
    const r = validateLogin({ email: "a@b.co", password: "" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.password);
  });

  it("forgot-password accepts shape; reset enforces token + password rules", () => {
    assert.equal(validateForgotPassword({ email: "a@b.co" }).ok, true);
    assert.equal(validateForgotPassword({ email: "bad" }).ok, false);
    const bad = validateResetPassword({ token: "short", password: "short" });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.token);
    assert.ok(bad.errors.password);
  });

  it("normalizeEmail trims and lowercases", () => {
    assert.equal(normalizeEmail("  Foo@Bar.COM "), "foo@bar.com");
  });
});

describe("rate limiter", () => {
  it("allows up to the limit, then blocks with retryAfterMs", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(() => now);
    for (let i = 0; i < 5; i++) {
      assert.equal(limiter.check("k", 5, 60_000).allowed, true);
    }
    const blocked = limiter.check("k", 5, 60_000);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);
  });

  it("forgets old attempts outside the window", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    assert.equal(limiter.check("k", 1, 1_000).allowed, true);
    assert.equal(limiter.check("k", 1, 1_000).allowed, false);
    now += 1_001;
    assert.equal(limiter.check("k", 1, 1_000).allowed, true);
  });

  it("tracks keys independently", () => {
    const limiter = new RateLimiter(() => 0);
    assert.equal(limiter.check("a", 1, 60_000).allowed, true);
    assert.equal(limiter.check("a", 1, 60_000).allowed, false);
    assert.equal(limiter.check("b", 1, 60_000).allowed, true);
  });
});
