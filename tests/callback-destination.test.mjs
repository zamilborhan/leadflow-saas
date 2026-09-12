// Callback destination policy unit tests: pure lib only (explicit .ts entry
// import works with Node type-stripping; callback-destination.ts has no
// project-local imports).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeNextPath,
  isDefaultDashboardDestination,
  resolveCallbackDestination,
} from "../src/lib/auth/callback-destination.ts";

describe("normalizeNextPath (open-redirect allowlist)", () => {
  it("accepts the allowlisted destinations with queries intact", () => {
    assert.equal(normalizeNextPath("/dashboard"), "/dashboard");
    assert.equal(
      normalizeNextPath("/dashboard/leads?businessId=123"),
      "/dashboard/leads?businessId=123"
    );
    assert.equal(normalizeNextPath("/onboarding/workspace"), "/onboarding/workspace");
    assert.equal(normalizeNextPath("/reset-password?token=abc"), "/reset-password?token=abc");
    assert.equal(normalizeNextPath("/admin/users"), "/admin/users");
  });

  it("rejects external, protocol-relative, and backslash escapes", () => {
    assert.equal(normalizeNextPath("https://evil.com"), null);
    assert.equal(normalizeNextPath("//evil.com"), null);
    assert.equal(normalizeNextPath("/\\evil.com"), null);
    assert.equal(normalizeNextPath("javascript:alert(1)"), null);
    assert.equal(normalizeNextPath(""), null);
    assert.equal(normalizeNextPath(null), null);
  });

  it("rejects unlisted app paths", () => {
    assert.equal(normalizeNextPath("/api/me"), null);
    assert.equal(normalizeNextPath("/login"), null);
    assert.equal(normalizeNextPath("/dashboard-settings"), null);
  });

  it("trims trailing slashes for matching but preserves allowed input", () => {
    assert.equal(normalizeNextPath("/dashboard/"), "/dashboard/");
    assert.equal(normalizeNextPath("/reset-password/"), "/reset-password/");
  });
});

describe("resolveCallbackDestination (workspace-aware routing)", () => {
  it("routes bare dashboard by workspace presence", () => {
    assert.equal(resolveCallbackDestination("/dashboard", true), "/dashboard");
    assert.equal(resolveCallbackDestination("/dashboard", false), "/onboarding/workspace");
    assert.equal(resolveCallbackDestination(null, true), "/dashboard");
    assert.equal(resolveCallbackDestination(null, false), "/onboarding/workspace");
  });

  it("respects explicit allowlisted deep links", () => {
    assert.equal(resolveCallbackDestination("/reset-password", true), "/reset-password");
    assert.equal(resolveCallbackDestination("/reset-password", false), "/reset-password");
    assert.equal(
      resolveCallbackDestination("/onboarding/workspace", true),
      "/onboarding/workspace"
    );
  });

  it("falls back workspace-aware on rejected input (never off-origin)", () => {
    assert.equal(resolveCallbackDestination("//evil.com", true), "/dashboard");
    assert.equal(resolveCallbackDestination("//evil.com", false), "/onboarding/workspace");
    assert.equal(
      resolveCallbackDestination("https://evil.com", false),
      "/onboarding/workspace"
    );
  });
});

describe("isDefaultDashboardDestination", () => {
  it("matches bare dashboard regardless of query or trailing slash", () => {
    assert.equal(isDefaultDashboardDestination("/dashboard"), true);
    assert.equal(isDefaultDashboardDestination("/dashboard?businessId=1"), true);
    assert.equal(isDefaultDashboardDestination("/dashboard/"), true);
    assert.equal(isDefaultDashboardDestination("/dashboard/leads"), false);
  });
});
