// Workspace role + permission matrix unit tests: pure lib only (explicit .ts
// entry import works with Node type-stripping; roles.ts has no
// project-local imports).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ROLES,
  ROLE_PERMISSIONS,
  hasPermission,
  canManageMember,
  assignableRoles,
  isValidRole,
  isValidPermission,
} from "../src/lib/tenancy/roles.ts";

describe("workspace roles + permission matrix (pure)", () => {
  it("supports exactly OWNER, ADMIN, SALES", () => {
    assert.deepEqual([...ROLES], ["OWNER", "ADMIN", "SALES"]);
  });

  it("OWNER grants every permission", () => {
    for (const code of ROLE_PERMISSIONS.OWNER) assert.ok(typeof code === "string");
    assert.ok(ROLE_PERMISSIONS.OWNER.includes("businesses.delete"));
    assert.ok(ROLE_PERMISSIONS.OWNER.includes("leads.delete"));
    assert.ok(ROLE_PERMISSIONS.OWNER.includes("members.invite"));
  });

  it("ADMIN cannot delete the business; SALES is least-privilege", () => {
    assert.ok(!ROLE_PERMISSIONS.ADMIN.includes("businesses.delete"));
    assert.ok(ROLE_PERMISSIONS.ADMIN.includes("leads.delete"));
    assert.ok(ROLE_PERMISSIONS.ADMIN.includes("followups.delete"));
    assert.ok(!ROLE_PERMISSIONS.SALES.includes("leads.delete"));
    assert.ok(!ROLE_PERMISSIONS.SALES.includes("leads.assign"));
    assert.ok(!ROLE_PERMISSIONS.SALES.includes("members.invite"));
    assert.ok(ROLE_PERMISSIONS.SALES.includes("leads.read"));
    assert.ok(ROLE_PERMISSIONS.SALES.includes("leads.create"));
    assert.ok(ROLE_PERMISSIONS.SALES.includes("leads.update"));
    assert.ok(ROLE_PERMISSIONS.SALES.includes("followups.read"));
    assert.ok(ROLE_PERMISSIONS.SALES.includes("followups.create"));
    assert.ok(ROLE_PERMISSIONS.SALES.includes("followups.update"));
    assert.ok(!ROLE_PERMISSIONS.SALES.includes("followups.delete"));
  });

  it("hasPermission enforces the matrix", () => {
    assert.equal(hasPermission("OWNER", "businesses.delete"), true);
    assert.equal(hasPermission("ADMIN", "businesses.delete"), false);
    assert.equal(hasPermission("SALES", "leads.read"), true);
    assert.equal(hasPermission("SALES", "members.remove"), false);
  });

  it("management rules: OWNER > ADMIN > SALES, ADMIN never touches OWNER", () => {
    assert.equal(canManageMember("OWNER", "OWNER", "SALES"), true);
    assert.equal(canManageMember("ADMIN", "SALES", "ADMIN"), true);
    assert.equal(canManageMember("ADMIN", "OWNER"), false);
    assert.equal(canManageMember("ADMIN", "SALES", "OWNER"), false);
    assert.equal(canManageMember("SALES", "SALES"), false);
  });

  it("assignable roles narrow by rank", () => {
    assert.deepEqual([...assignableRoles("OWNER")], ["OWNER", "ADMIN", "SALES"]);
    assert.deepEqual([...assignableRoles("ADMIN")], ["ADMIN", "SALES"]);
    assert.deepEqual([...assignableRoles("SALES")], []);
  });

  it("isValidRole / isValidPermission reject unknown values", () => {
    assert.equal(isValidRole("OWNER"), true);
    assert.equal(isValidRole("SUPERADMIN"), false);
    assert.equal(isValidRole(null), false);
    assert.equal(isValidPermission("leads.read"), true);
    assert.equal(isValidPermission("leads.nuke"), false);
  });
});
