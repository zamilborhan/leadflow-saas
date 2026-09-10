/**
 * WhatsApp inbound webhook payload extraction. Pure module (no imports) so
 * unit tests exercise it directly.
 *
 * Per Meta's Cloud API webhook docs, WhatsApp deliveries look like:
 * { object: "whatsapp_business_account", entry: [{ id, changes: [{
 *   field: "messages", value: {
 *     messaging_product: "whatsapp",
 *     metadata: { display_phone_number, phone_number_id },
 *     contacts?: [{ profile: { name }, wa_id }],
 *     messages?: [{ from, id, timestamp, type, text?: { body },
 *       button?: { text }, interactive?: {...}, image?: { caption },
 *       video?: { caption }, audio?: {}, document?: { caption },
 *       location?: {}, contacts?: [...] }],
 *     statuses?: [{ id, status, timestamp, recipient_id, errors?: [...] }]
 *   }}]}] }
 * Entries/changes batch, non-message fields are ignored, and malformed
 * values are skipped (never throw on attacker-controlled JSON).
 */

export interface InboundMessage {
  /** Meta wamid — the idempotency key. */
  wamid: string;
  /** Customer wa_id (digits, no +). */
  from: string;
  timestampMs: number | null;
  /** Meta message type (text, image, ...). Lowercased as received. */
  type: string;
  /** Decoded human-readable text (or caption/placeholder). Never null. */
  body: string;
  /** Sender display name when Meta provides it. */
  senderName: string | null;
}

export interface InboundStatus {
  /** Wamid of the outbound message this receipt refers to. */
  wamid: string;
  /** Raw Meta status (sent, delivered, read, failed, ...). Lowercased. */
  status: string;
  timestampMs: number | null;
  recipientId: string | null;
}

export interface InboundChange {
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  messages: InboundMessage[];
  statuses: InboundStatus[];
}

function asId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asText(value: unknown, max = 2000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

function asTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Meta sends seconds ("timestamp": "1757320000").
    return Math.floor(value * 1000);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value.trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n * 1000);
  }
  return null;
}

/** Digits only — wa_ids, +880..., 01..., spaces/dashes all collapse. */
export function normalizePhoneDigits(phone: unknown): string {
  if (typeof phone !== "string") return "";
  return phone.replace(/\D/g, "");
}

/**
 * Safe phone equality: exact digit match, or last-10-digit match for long
 * numbers (covers +8801XXXXXXXXX vs 01XXXXXXXXX). Short numbers (<10
 * digits) must match exactly — never fuzzy-match those.
 */
export function samePhoneNumber(aDigits: string, bDigits: string): boolean {
  if (!aDigits || !bDigits) return false;
  if (aDigits === bDigits) return true;
  if (aDigits.length >= 10 && bDigits.length >= 10) {
    return aDigits.slice(-10) === bDigits.slice(-10);
  }
  return false;
}

/** True for WhatsApp Business Account deliveries (the only kind we process). */
export function isWhatsappDelivery(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const rec = payload as Record<string, unknown>;
  if (rec["object"] !== "whatsapp_business_account") return false;
  return Array.isArray(rec["entry"]);
}

function nestedText(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  for (const key of keys) {
    const found = asText(rec[key]);
    if (found) return found;
  }
  return null;
}

function bodyForMessage(raw: Record<string, unknown>, type: string): string {
  switch (type) {
    case "text":
      return nestedText(raw["text"], ["body"]) ?? "[text message]";
    case "button":
      return nestedText(raw["button"], ["text"]) ?? "[button reply]";
    case "interactive": {
      const interactive = raw["interactive"];
      if (interactive && typeof interactive === "object") {
        const rec = interactive as Record<string, unknown>;
        const reply = rec["button_reply"] ?? rec["list_reply"];
        if (reply && typeof reply === "object") {
          const title = nestedText(reply, ["title"]);
          if (title) return title;
        }
        const body = rec["body"];
        if (body && typeof body === "object") {
          const text = nestedText(body, ["text"]);
          if (text) return text;
        }
      }
      return "[interactive reply]";
    }
    case "image":
      return nestedText(raw["image"], ["caption"]) ?? "[image]";
    case "video":
      return nestedText(raw["video"], ["caption"]) ?? "[video]";
    case "audio":
      return "[audio]";
    case "document":
      return nestedText(raw["document"], ["caption", "filename"]) ?? "[document]";
    case "sticker":
      return "[sticker]";
    case "location": {
      const loc = raw["location"];
      if (loc && typeof loc === "object") {
        const rec = loc as Record<string, unknown>;
        const lat = rec["latitude"];
        const lng = rec["longitude"];
        if (typeof lat === "number" && typeof lng === "number") {
          return `[location ${lat}, ${lng}]`;
        }
      }
      return "[location]";
    }
    case "contacts":
      return "[contact]";
    case "reaction":
      return nestedText(raw["reaction"], ["emoji"]) ?? "[reaction]";
    default:
      return `[${type || "unknown"} message]`;
  }
}

function parseMessage(entry: unknown, senderByWaId: Map<string, string>): InboundMessage | null {
  if (!entry || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  const wamid = asId(rec["id"]);
  const from = asId(rec["from"]);
  if (!wamid || !from) return null;
  const rawType = typeof rec["type"] === "string" ? rec["type"].toLowerCase() : "text";
  const body = bodyForMessage(rec, rawType);
  return {
    wamid,
    from,
    timestampMs: asTimestampMs(rec["timestamp"]),
    type: rawType || "text",
    body,
    senderName: senderByWaId.get(normalizePhoneDigits(from)) ?? null,
  };
}

function parseStatus(entry: unknown): InboundStatus | null {
  if (!entry || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  const wamid = asId(rec["id"]);
  const rawStatus = typeof rec["status"] === "string" ? rec["status"].toLowerCase() : null;
  if (!wamid || !rawStatus) return null;
  return {
    wamid,
    status: rawStatus,
    timestampMs: asTimestampMs(rec["timestamp"]),
    recipientId: asId(rec["recipient_id"]),
  };
}

/**
 * Extract every well-formed inbound change. Skips entries/changes with
 * missing phone_number_id or non-message fields — callers treat an empty
 * result on a well-formed payload as "nothing to do" (still 200).
 */
export function extractWhatsappEvents(payload: unknown): InboundChange[] {
  if (!isWhatsappDelivery(payload)) return [];
  const out: InboundChange[] = [];
  const entries = (payload as { entry: unknown[] }).entry;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const changes = (entry as Record<string, unknown>)["changes"];
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const rec = change as Record<string, unknown>;
      if (rec["field"] !== "messages") continue;
      const value = rec["value"];
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const metadata = v["metadata"];
      const phoneNumberId =
        metadata && typeof metadata === "object"
          ? asId((metadata as Record<string, unknown>)["phone_number_id"])
          : null;
      if (!phoneNumberId) continue;
      const displayPhoneNumber =
        metadata && typeof metadata === "object"
          ? asId((metadata as Record<string, unknown>)["display_phone_number"])
          : null;
      const senderByWaId = new Map<string, string>();
      const contacts = v["contacts"];
      if (Array.isArray(contacts)) {
        for (const c of contacts) {
          if (!c || typeof c !== "object") continue;
          const cr = c as Record<string, unknown>;
          const waId = asId(cr["wa_id"]);
          if (!waId) continue;
          const profile = cr["profile"];
          const name =
            profile && typeof profile === "object"
              ? asText((profile as Record<string, unknown>)["name"], 200)
              : null;
          if (name) senderByWaId.set(normalizePhoneDigits(waId), name);
        }
      }
      const messages: InboundMessage[] = [];
      const rawMessages = v["messages"];
      if (Array.isArray(rawMessages)) {
        for (const m of rawMessages) {
          const parsed = parseMessage(m, senderByWaId);
          if (parsed) messages.push(parsed);
        }
      }
      const statuses: InboundStatus[] = [];
      const rawStatuses = v["statuses"];
      if (Array.isArray(rawStatuses)) {
        for (const s of rawStatuses) {
          const parsed = parseStatus(s);
          if (parsed) statuses.push(parsed);
        }
      }
      if (messages.length === 0 && statuses.length === 0) continue;
      out.push({ phoneNumberId, displayPhoneNumber, messages, statuses });
    }
  }
  return out;
}
