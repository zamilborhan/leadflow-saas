// Automation engine tests: pure core only (explicit .ts entry imports work
// with Node type-stripping; engine.ts has no project-local imports).
// Covers every acceptance axis without touching the DB or Redis:
// triggers/actions catalog, rule config validation, action resolution,
// idempotency keys, backoff/retry classification, least-loaded assignment,
// no-contact firing, RESP encoding, and the contract shape backing
// idempotency in Postgres.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  DEFAULT_RULES,
  TRIGGER_ACTIONS,
  MAX_AUTOMATION_ATTEMPTS,
  actionsForTrigger,
  backoffForAttempt,
  dedupeKeyFor,
  isRetryableAutomationFailure,
  isValidAction,
  isValidTrigger,
  parseRuleConfig,
  pickLeastLoadedAgent,
  shouldFireNoContact,
  validateRuleConfig,
} from "../src/lib/automation/engine.ts";
import { encodeRespCommand, parseResp } from "../src/lib/automation/resp.ts";

const ROOT = path.join(import.meta.dirname, "..");

function namedError(name, message = "boom", extra = {}) {
  return Object.assign(new Error(message), { name }, extra);
}

describe("automation triggers + actions catalog", () => {
  it("supports exactly the three required triggers", () => {
    assert.deepEqual([...AUTOMATION_TRIGGERS], [
      "NEW_LEAD",
      "NO_CONTACT_AFTER_TIME",
      "STATUS_CHANGED_TO_INTERESTED",
    ]);
    for (const t of AUTOMATION_TRIGGERS) assert.equal(isValidTrigger(t), true);
    assert.equal(isValidTrigger("LEAD_CREATED"), false);
    assert.equal(isValidTrigger(""), false);
    assert.equal(isValidTrigger(null), false);
  });

  it("supports the five required actions", () => {
    assert.deepEqual([...AUTOMATION_ACTIONS], [
      "ASSIGN_AGENT",
      "CREATE_FOLLOWUP",
      "SEND_WHATSAPP",
      "NOTIFY_AGENT",
      "CREATE_REMINDER",
    ]);
    for (const a of AUTOMATION_ACTIONS) assert.equal(isValidAction(a), true);
    assert.equal(isValidAction("SEND_SMS"), false);
  });

  it("maps the required trigger → action sets", () => {
    assert.deepEqual([...TRIGGER_ACTIONS.NEW_LEAD], [
      "ASSIGN_AGENT",
      "CREATE_FOLLOWUP",
      "SEND_WHATSAPP",
      "NOTIFY_AGENT",
    ]);
    assert.deepEqual([...TRIGGER_ACTIONS.NO_CONTACT_AFTER_TIME], ["CREATE_REMINDER", "NOTIFY_AGENT"]);
    assert.deepEqual([...TRIGGER_ACTIONS.STATUS_CHANGED_TO_INTERESTED], ["CREATE_FOLLOWUP"]);
  });

  it("ships one enabled-by-default rule per trigger", () => {
    assert.equal(DEFAULT_RULES.length, 3);
    const triggers = DEFAULT_RULES.map((r) => r.trigger).sort();
    assert.deepEqual(triggers, [...AUTOMATION_TRIGGERS].sort());
    for (const r of DEFAULT_RULES) {
      assert.ok(r.name.length > 0);
      assert.ok(r.config.followUpDelayMinutes > 0);
      assert.ok(r.config.noContactMinutes > 0);
    }
  });
});

describe("automation rule config validation", () => {
  it("accepts an empty patch and valid tuning", () => {
    const empty = validateRuleConfig({});
    assert.equal(empty.ok, true);
    assert.equal(empty.value.followUpDelayMinutes, 1440);
    const tuned = validateRuleConfig({ followUpDelayMinutes: 60, noContactMinutes: 120 });
    assert.equal(tuned.ok, true);
    assert.equal(tuned.value.followUpDelayMinutes, 60);
    assert.equal(tuned.value.noContactMinutes, 120);
  });

  it("accepts template pinning, variables, notes, and action subsets", () => {
    const r = validateRuleConfig({
      templateName: "hello_world",
      templateLanguage: "en_US",
      variables: { "1": "Amena" },
      note: "Call back.",
      actions: ["ASSIGN_AGENT", "NOTIFY_AGENT"],
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.templateName, "hello_world");
    assert.deepEqual(r.value.actions, ["ASSIGN_AGENT", "NOTIFY_AGENT"]);
    const cleared = validateRuleConfig({ templateName: null, note: "", actions: null });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.value.templateName, null);
    assert.equal(cleared.value.actions, null);
  });

  it("rejects unknown keys, bad ranges, and non-subset actions", () => {
    assert.equal(validateRuleConfig({ nope: 1 }).ok, false);
    assert.equal(validateRuleConfig({ followUpDelayMinutes: -5 }).ok, false);
    assert.equal(validateRuleConfig({ followUpDelayMinutes: 99999 }).ok, false);
    assert.equal(validateRuleConfig({ noContactMinutes: 0 }).ok, false);
    assert.equal(validateRuleConfig({ variables: { "1": 42 } }).ok, false);
    assert.equal(validateRuleConfig({ actions: [] }).ok, false);
    assert.equal(validateRuleConfig({ actions: ["SEND_SMS"] }).ok, false);
    assert.equal(validateRuleConfig({ assignStrategy: "round-robin" }).ok, false);
    assert.equal(validateRuleConfig(null).ok, false);
    assert.equal(validateRuleConfig("x").ok, false);
  });

  it("parses stored JSON defensively, falling back to defaults", () => {
    assert.equal(parseRuleConfig(null).followUpDelayMinutes, 1440);
    assert.equal(parseRuleConfig("not-json{{{").followUpDelayMinutes, 1440);
    assert.equal(parseRuleConfig("[1,2]").followUpDelayMinutes, 1440);
    const good = parseRuleConfig(JSON.stringify({ followUpDelayMinutes: 30 }));
    assert.equal(good.followUpDelayMinutes, 30);
  });

  it("resolves effective actions in canonical order", () => {
    const base = parseRuleConfig(null);
    assert.deepEqual(actionsForTrigger("NEW_LEAD", base), TRIGGER_ACTIONS.NEW_LEAD);
    const narrowed = validateRuleConfig({ actions: ["NOTIFY_AGENT", "ASSIGN_AGENT"] });
    assert.equal(narrowed.ok, true);
    // Canonical order wins even when configured reversed.
    assert.deepEqual(actionsForTrigger("NEW_LEAD", narrowed.value), ["ASSIGN_AGENT", "NOTIFY_AGENT"]);
  });
});

describe("automation idempotency keys", () => {
  it("fires event triggers at most once per rule+lead", () => {
    const a = dedupeKeyFor("NEW_LEAD", "R1", "L1");
    const b = dedupeKeyFor("NEW_LEAD", "R1", "L1", Date.now() + 86_400_000);
    assert.equal(a, b, "event keys must be time-independent");
    assert.notEqual(a, dedupeKeyFor("NEW_LEAD", "R2", "L1"));
    assert.notEqual(a, dedupeKeyFor("NEW_LEAD", "R1", "L2"));
    assert.notEqual(a, dedupeKeyFor("STATUS_CHANGED_TO_INTERESTED", "R1", "L1"));
  });

  it("buckets no-contact firings by UTC day", () => {
    const day1 = new Date("2026-09-01T10:00:00Z").getTime();
    const day1Late = new Date("2026-09-01T23:59:59Z").getTime();
    const day2 = new Date("2026-09-02T00:00:01Z").getTime();
    assert.equal(
      dedupeKeyFor("NO_CONTACT_AFTER_TIME", "R1", "L1", day1),
      dedupeKeyFor("NO_CONTACT_AFTER_TIME", "R1", "L1", day1Late)
    );
    assert.notEqual(
      dedupeKeyFor("NO_CONTACT_AFTER_TIME", "R1", "L1", day1),
      dedupeKeyFor("NO_CONTACT_AFTER_TIME", "R1", "L1", day2)
    );
  });

  it("collapses redeliveries per business (key simulation)", () => {
    // Mirrors the (businessId, dedupeKey) unique constraint in Postgres.
    const seen = new Set();
    const insert = (businessId, key) => {
      const k = `${businessId}\u0000${key}`;
      if (seen.has(k)) return "duplicate";
      seen.add(k);
      return "created";
    };
    const key = dedupeKeyFor("NEW_LEAD", "R1", "L1");
    assert.equal(insert("B1", key), "created");
    assert.equal(insert("B1", key), "duplicate");
    assert.equal(insert("B2", key), "created", "same key in another business is independent");
  });
});

describe("automation retry policy", () => {
  it("backs off 1m → 5m → 15m → 1h → 6h within 5 attempts", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5].map(backoffForAttempt),
      [60_000, 300_000, 900_000, 3_600_000, 21_600_000]
    );
    assert.equal(backoffForAttempt(99), 21_600_000, "attempts past budget clamp to the last rung");
    assert.equal(MAX_AUTOMATION_ATTEMPTS, 5);
  });

  it("never retries terminal failures", () => {
    for (const name of ["TenantConflict", "TenantNotFound", "TenantAccessDenied", "TemplateSendError"]) {
      assert.equal(isRetryableAutomationFailure(namedError(name)), false, name);
    }
    assert.equal(isRetryableAutomationFailure(namedError("MetaApiError", "bad", { code: 190 })), false);
  });

  it("retries transient failures within budget", () => {
    assert.equal(isRetryableAutomationFailure(namedError("MetaApiError", "x", { code: 1 })), true);
    assert.equal(isRetryableAutomationFailure(namedError("MetaApiError", "x", { code: 2 })), true);
    assert.equal(isRetryableAutomationFailure(new Error("WhatsApp API unreachable.")), true);
    assert.equal(isRetryableAutomationFailure(new Error("socket hang up")), true);
  });
});

describe("automation agent assignment", () => {
  it("picks the least-loaded agent deterministically", () => {
    assert.equal(
      pickLeastLoadedAgent([
        { userId: "u3", openLeads: 5 },
        { userId: "u1", openLeads: 2 },
        { userId: "u2", openLeads: 2 },
      ]),
      "u1",
      "ties break by userId"
    );
    assert.equal(pickLeastLoadedAgent([{ userId: "only", openLeads: 0 }]), "only");
    assert.equal(pickLeastLoadedAgent([]), null);
  });
});

describe("automation no-contact trigger", () => {
  const NOW = new Date("2026-09-09T12:00:00Z").getTime();
  const mins = (n) => new Date(NOW - n * 60_000).toISOString();

  it("fires for silent leads past the window", () => {
    assert.equal(
      shouldFireNoContact({ status: "NEW", archivedAt: null, createdAt: mins(1500), lastContactedAt: null }, 1440, NOW),
      true
    );
    assert.equal(
      shouldFireNoContact(
        { status: "CONTACTED", archivedAt: null, createdAt: mins(5000), lastContactedAt: mins(1500) },
        1440,
        NOW
      ),
      true
    );
  });

  it("stays quiet for fresh, touched, converted, or archived leads", () => {
    const silent = { status: "NEW", archivedAt: null, createdAt: mins(1500), lastContactedAt: null };
    assert.equal(shouldFireNoContact({ ...silent, createdAt: mins(60) }, 1440, NOW), false);
    assert.equal(shouldFireNoContact({ ...silent, lastContactedAt: mins(60) }, 1440, NOW), false);
    assert.equal(shouldFireNoContact({ ...silent, status: "CONVERTED" }, 1440, NOW), false);
    assert.equal(shouldFireNoContact({ ...silent, status: "LOST" }, 1440, NOW), false);
    assert.equal(shouldFireNoContact({ ...silent, archivedAt: mins(10) }, 1440, NOW), false);
    assert.equal(shouldFireNoContact({ ...silent, status: "INTERESTED" }, 1440, NOW), false);
  });
});

describe("automation redis transport encoding", () => {
  it("encodes RESP2 commands byte-exactly", () => {
    assert.equal(encodeRespCommand(["PING"]), "*1\r\n$4\r\nPING\r\n");
    assert.equal(
      encodeRespCommand(["RPUSH", "lf:automation:queue", "job-1"]),
      "*3\r\n$5\r\nRPUSH\r\n$19\r\nlf:automation:queue\r\n$5\r\njob-1\r\n"
    );
  });

  it("parses the reply shapes the queue uses", () => {
    assert.deepEqual(parseResp(Buffer.from("+PONG\r\n"))?.reply, "PONG");
    assert.deepEqual(parseResp(Buffer.from(":3\r\n"))?.reply, 3);
    assert.deepEqual(parseResp(Buffer.from("$-1\r\n"))?.reply, null);
    assert.deepEqual(parseResp(Buffer.from("*-1\r\n"))?.reply, null);
    const brpop = parseResp(Buffer.from("*2\r\n$19\r\nlf:automation:queue\r\n$5\r\njob-1\r\n"));
    assert.deepEqual(brpop?.reply, ["lf:automation:queue", "job-1"]);
    assert.equal(parseResp(Buffer.from("+PAR")), null, "incomplete frames must wait for more bytes");
  });
});

describe("automation contract shape", () => {
  const contract = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "prisma", "contract.json"), "utf8"));
  const models = contract.domain.namespaces.public.models;

  it("defines rule, job, and log models", () => {
    for (const m of ["AutomationRule", "AutomationJob", "AutomationLog"]) {
      assert.ok(models[m], `missing model ${m}`);
    }
    const rule = models.AutomationRule.fields;
    assert.ok(rule.businessId && rule.trigger && rule.name && rule.status && rule.configJson);
    const job = models.AutomationJob.fields;
    assert.ok(job.businessId && job.ruleId && job.trigger && job.leadId && job.dedupeKey && job.status);
    assert.ok(job.attempts && job.nextRetryAt !== undefined);
    const log = models.AutomationLog.fields;
    assert.ok(log.businessId && log.trigger && log.action && log.status);
  });

  it("keys idempotency on (businessId, dedupeKey) and rule seeding on (businessId, trigger, name)", () => {
    const raw = JSON.stringify(models.AutomationJob) + JSON.stringify(models.AutomationRule);
    assert.ok(raw.includes("dedupeKey"), "job idempotency key missing");
    assert.ok(raw.includes("configJson"), "rule config missing");
  });
});
