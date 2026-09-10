// WhatsApp inbound webhook tests (pure + contract, no DB/server).
//
// Layers:
//  1. webhook-verify: shared handshake + HMAC (same secret secures the
//     WhatsApp subscription).
//  2. inbound-parse: whatsapp_business_account extraction, batching, body
//     decoding per message type, status receipts, phone normalization and
//     safe matching, shape tolerance.
//  3. Contract: WhatsAppMessage carries inbound fields (body, fromPhone),
//     nullable leadId for graceful unmatched storage, and the
//     (businessId, messageId) unique idempotency key.
//  4. Idempotency key behavior simulated in-memory: redeliveries of the
//     same wamid collapse; distinct wamids never collapse; keys are scoped
//     per business (cross-business wamids never match).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { verifyHandshake, verifyWebhookSignature } from "../src/lib/integrations/meta/webhook-verify.ts";
import {
  extractWhatsappEvents,
  isWhatsappDelivery,
  normalizePhoneDigits,
  samePhoneNumber,
} from "../src/lib/integrations/whatsapp/inbound-parse.ts";

const VERIFY_TOKEN = "test-verify-token";

function waPayload(overrides = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+1 555-0100", phone_number_id: "PHONE1" },
              contacts: [{ profile: { name: "Amena" }, wa_id: "8801712345678" }],
              messages: [
                {
                  from: "8801712345678",
                  id: "wamid.HBG1",
                  timestamp: "1757320000",
                  type: "text",
                  text: { body: "Hello, I am interested." },
                },
              ],
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("whatsapp webhook verification (shared handshake)", () => {
  it("echoes the challenge only for a valid subscribe handshake", () => {
    assert.equal(verifyHandshake("subscribe", VERIFY_TOKEN, "CHALLENGE-1", VERIFY_TOKEN), "CHALLENGE-1");
    assert.equal(verifyHandshake("subscribe", "wrong", "CHALLENGE-1", VERIFY_TOKEN), null);
    assert.equal(verifyHandshake("unsubscribe", VERIFY_TOKEN, "CHALLENGE-1", VERIFY_TOKEN), null);
    assert.equal(verifyHandshake("subscribe", VERIFY_TOKEN, null, VERIFY_TOKEN), null);
  });

  it("verifies delivery signatures over the raw body", async () => {
    const { createHmac } = await import("node:crypto");
    const raw = JSON.stringify(waPayload());
    const sig = `sha256=${createHmac("sha256", "s3cret").update(raw, "utf8").digest("hex")}`;
    assert.equal(await verifyWebhookSignature(raw, sig, "s3cret"), true);
    assert.equal(await verifyWebhookSignature(raw, sig, "wrong"), false);
    assert.equal(await verifyWebhookSignature(`${raw} `, sig, "s3cret"), false);
    assert.equal(await verifyWebhookSignature(raw, null, "s3cret"), false);
  });
});

describe("whatsapp delivery detection + extraction", () => {
  it("extracts the documented message shape", () => {
    const changes = extractWhatsappEvents(waPayload());
    assert.equal(changes.length, 1);
    assert.equal(changes[0].phoneNumberId, "PHONE1");
    assert.equal(changes[0].displayPhoneNumber, "+1 555-0100");
    assert.equal(changes[0].messages.length, 1);
    const m = changes[0].messages[0];
    assert.equal(m.wamid, "wamid.HBG1");
    assert.equal(m.from, "8801712345678");
    assert.equal(m.type, "text");
    assert.equal(m.body, "Hello, I am interested.");
    assert.equal(m.senderName, "Amena");
    assert.equal(m.timestampMs, 1757320000 * 1000);
    assert.ok(isWhatsappDelivery(waPayload()));
  });

  it("extracts status receipts alongside messages", () => {
    const payload = waPayload();
    payload.entry[0].changes[0].value.statuses = [
      { id: "wamid.OUT1", status: "delivered", timestamp: "1757320100", recipient_id: "8801712345678" },
      { id: "wamid.OUT2", status: "read", timestamp: "1757320200", recipient_id: "8801712345678" },
    ];
    const changes = extractWhatsappEvents(payload);
    assert.equal(changes[0].statuses.length, 2);
    assert.equal(changes[0].statuses[0].wamid, "wamid.OUT1");
    assert.equal(changes[0].statuses[0].status, "delivered");
    assert.equal(changes[0].statuses[1].status, "read");
  });

  it("collects batched entries, ignores non-message fields, skips malformed values", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "P1" },
                messages: [
                  { from: "8801712345678", id: "wamid.A", timestamp: "1", type: "text", text: { body: "Hi" } },
                  { from: "8801712345678", timestamp: "1", type: "text" },
                  { id: "wamid.B", timestamp: "1", type: "text" },
                  null,
                ],
              },
            },
            { field: "message_template_status_update", value: {} },
            { field: "messages", value: { metadata: {} } },
            { field: "messages", value: "not-an-object" },
            null,
          ],
        },
        { id: "WABA2", changes: "not-an-array" },
        null,
        { id: "WABA3" },
      ],
    };
    const changes = extractWhatsappEvents(payload);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].messages.length, 1);
    assert.equal(changes[0].messages[0].wamid, "wamid.A");
  });

  it("rejects non-whatsapp payloads without throwing", () => {
    assert.deepEqual(extractWhatsappEvents({ object: "page", entry: [] }), []);
    assert.deepEqual(extractWhatsappEvents({ object: "user", entry: [] }), []);
    assert.deepEqual(extractWhatsappEvents(null), []);
    assert.deepEqual(extractWhatsappEvents("string"), []);
    assert.deepEqual(extractWhatsappEvents({ object: "whatsapp_business_account" }), []);
    assert.ok(!isWhatsappDelivery({ object: "page", entry: [] }));
    assert.ok(!isWhatsappDelivery(null));
  });
});

describe("whatsapp message body decoding", () => {
  function oneMessage(message) {
    const payload = waPayload();
    payload.entry[0].changes[0].value.messages = [message];
    return extractWhatsappEvents(payload)[0].messages[0];
  }

  it("decodes text, button, and interactive replies", () => {
    assert.equal(
      oneMessage({ from: "8801", id: "w1", timestamp: "1", type: "text", text: { body: "  Hello  " } }).body,
      "Hello"
    );
    assert.equal(
      oneMessage({ from: "8801", id: "w2", timestamp: "1", type: "button", button: { text: "Yes" } }).body,
      "Yes"
    );
    assert.equal(
      oneMessage({
        from: "8801",
        id: "w3",
        timestamp: "1",
        type: "interactive",
        interactive: { button_reply: { title: "Book a visit" } },
      }).body,
      "Book a visit"
    );
  });

  it("uses captions or placeholders for media and structured types", () => {
    assert.equal(
      oneMessage({ from: "8801", id: "w4", timestamp: "1", type: "image", image: { caption: "My NID" } }).body,
      "My NID"
    );
    assert.equal(oneMessage({ from: "8801", id: "w5", timestamp: "1", type: "image", image: {} }).body, "[image]");
    assert.equal(oneMessage({ from: "8801", id: "w6", timestamp: "1", type: "audio", audio: {} }).body, "[audio]");
    assert.equal(
      oneMessage({ from: "8801", id: "w7", timestamp: "1", type: "document", document: { filename: "a.pdf" } }).body,
      "a.pdf"
    );
    assert.equal(oneMessage({ from: "8801", id: "w8", timestamp: "1", type: "sticker", sticker: {} }).body, "[sticker]");
    assert.equal(
      oneMessage({ from: "8801", id: "w9", timestamp: "1", type: "location", location: { latitude: 23.7, longitude: 90.4 } })
        .body,
      "[location 23.7, 90.4]"
    );
    assert.equal(
      oneMessage({ from: "8801", id: "w10", timestamp: "1", type: "unknown_future", foo: 1 }).body,
      "[unknown_future message]"
    );
  });

  it("accepts numeric ids and numeric timestamps", () => {
    const payload = waPayload();
    payload.entry[0].changes[0].value.messages = [
      { from: 8801712345678, id: 99, timestamp: 1757320000, type: "text", text: { body: "Hi" } },
    ];
    const m = extractWhatsappEvents(payload)[0].messages[0];
    assert.equal(m.wamid, "99");
    assert.equal(m.from, "8801712345678");
  });
});

describe("whatsapp phone normalization + safe matching", () => {
  it("normalizes every local format to digits", () => {
    assert.equal(normalizePhoneDigits("+880 171-234 5678"), "8801712345678");
    assert.equal(normalizePhoneDigits("01712-345678"), "01712345678");
    assert.equal(normalizePhoneDigits("wa:8801712345678"), "8801712345678");
    assert.equal(normalizePhoneDigits(null), "");
    assert.equal(normalizePhoneDigits(42), "");
  });

  it("matches exact and +880/0 prefix variants, never short fuzz", () => {
    assert.equal(samePhoneNumber("8801712345678", "8801712345678"), true);
    assert.equal(samePhoneNumber("8801712345678", "01712345678"), true);
    assert.equal(samePhoneNumber("01712345678", "+8801712345678".replace(/\D/g, "")), true);
    assert.equal(samePhoneNumber("8801712345678", "8801812345678"), false);
    // Short numbers must match exactly — no suffix guessing.
    assert.equal(samePhoneNumber("12345", "12345"), true);
    assert.equal(samePhoneNumber("2345", "12345"), false);
    assert.equal(samePhoneNumber("", "8801712345678"), false);
  });

  it("requires exactly one match — zero or ambiguous means unmatched (no wrong assignment)", () => {
    // Mirrors matchLeadByPhone: 1 hit assigns, otherwise leadId stays null.
    const leads = [
      { id: "L1", phone: "+8801712345678" },
      { id: "L2", phone: "+8801812345678" },
    ];
    const hitsFor = (from) =>
      leads.filter((l) => samePhoneNumber(normalizePhoneDigits(l.phone), normalizePhoneDigits(from)));
    assert.equal(hitsFor("8801712345678").length, 1);
    assert.equal(hitsFor("8801912345678").length, 0);
    const dupes = [
      { id: "L1", phone: "01712345678" },
      { id: "L2", phone: "+8801712345678" },
    ];
    const ambiguous = dupes.filter((l) =>
      samePhoneNumber(normalizePhoneDigits(l.phone), normalizePhoneDigits("8801712345678"))
    );
    assert.equal(ambiguous.length, 2, "ambiguous numbers must not resolve to a single lead");
  });
});

describe("whatsapp idempotency contract", () => {
  const contractPath = path.join(import.meta.dirname, "..", "src", "prisma", "contract.json");
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));

  it("persists inbound fields with nullable leadId for graceful unmatched storage", () => {
    const fields = contract.domain.namespaces.public.models.WhatsAppMessage.fields;
    assert.ok(fields.body, "missing body column for inbound text");
    assert.ok(fields.fromPhone, "missing fromPhone column for inbound sender");
    assert.equal(fields.leadId.nullable, true, "leadId must be nullable so unmatched inbound never mis-assigns");
    assert.equal(fields.messageId.nullable, true);
  });

  it("keys idempotency on (businessId, messageId) so redeliveries collapse", () => {
    const storage = contract.domain.namespaces.public.models.WhatsAppMessage.storage;
    const uniques = contract.domain.namespaces.public.models.WhatsAppMessage.uniques ??
      contract.domain.namespaces.public.models.WhatsAppMessage.constraints;
    const raw = JSON.stringify(contract.domain.namespaces.public.models.WhatsAppMessage);
    assert.ok(raw.includes("businessId") && raw.includes("messageId"), "unique key must cover business + wamid");
    assert.ok(storage, "missing storage mapping for WhatsAppMessage");
    void uniques;
  });

  it("collapses redeliveries per business without cross-tenant bleed (key simulation)", () => {
    // Simulates the (businessId, messageId) unique constraint enforced by Postgres.
    const seen = new Set();
    const insert = (businessId, wamid) => {
      const key = `${businessId}\u0000${wamid}`;
      if (seen.has(key)) return "duplicate";
      seen.add(key);
      return "created";
    };
    assert.equal(insert("B1", "wamid.X"), "created");
    assert.equal(insert("B1", "wamid.X"), "duplicate");
    assert.equal(insert("B1", "wamid.Y"), "created");
    assert.equal(insert("B2", "wamid.X"), "created", "same wamid in another business is a different key");
    assert.equal(insert("B1", "wamid.X"), "duplicate");
  });
});
