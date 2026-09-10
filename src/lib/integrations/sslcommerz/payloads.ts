/**
 * SSLCommerz payload parsing + money math (pure — no imports).
 *
 * Shapes follow the official v4 docs (developer.sslcommerz.com/doc/v4):
 * IPN posts `status` (VALID | FAILED | CANCELLED | EXPIRED | UNATTEMPTED),
 * `tran_id`, `val_id`, `amount`, `currency`/`currency_type`, `risk_level`,
 * and `verify_sign`/`verify_key`; the Order Validation API answers
 * VALID | VALIDATED | INVALID_TRANSACTION with the authoritative
 * `tran_id`/`amount`/`currency`.
 *
 * Money is compared in integer minor units (poisha) so gateway decimals
 * never flow through floats. IPN authenticity is NOT established locally
 * (the docs define no stable local-signature contract for us to check) —
 * it is established by the mandatory server-side validation call plus
 * tran_id/amount/currency matching against our own records.
 */

export const IPN_STATUSES = ["VALID", "FAILED", "CANCELLED", "EXPIRED", "UNATTEMPTED"] as const;
export type IpnStatus = (typeof IPN_STATUSES)[number];

export const VALIDATION_OK_STATUSES = ["VALID", "VALIDATED"] as const;

export interface IpnPayload {
  status: IpnStatus;
  tranId: string;
  /** Absent on non-success callbacks — never trust those paths. */
  valId: string | null;
  /** Minor units when parseable, else null (treated as mismatch). */
  amountMinor: number | null;
  currency: string | null;
  /** 0 = safe, 1 = risky. Fail-closed: unparseable means risky. */
  riskLevel: 0 | 1;
  rawAmount: string | null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Decimal string ("100", "100.00", "100.5") → integer minor units.
 * Returns null for anything that is not a plain non-negative decimal with
 * at most two fraction digits.
 */
export function toMinorUnits(decimal: unknown): number | null {
  if (typeof decimal !== "string") return null;
  const trimmed = decimal.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  const whole = Number(match[1]);
  const frac = Number((match[2] ?? "0").padEnd(2, "0"));
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(frac)) return null;
  const minor = whole * 100 + frac;
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Integer minor units → "100.00" decimal string for the init API. */
export function toDecimalString(minor: number): string {
  const safe = Number.isSafeInteger(minor) && minor >= 0 ? minor : 0;
  return `${Math.floor(safe / 100)}.${String(safe % 100).padStart(2, "0")}`;
}

/** "49000" → "৳490.00" for UI and notification text. */
export function formatMinorBdt(minor: number): string {
  const safe = Number.isSafeInteger(minor) && minor >= 0 ? minor : 0;
  const whole = Math.floor(safe / 100).toLocaleString("en-US");
  return `৳${whole}.${String(safe % 100).padStart(2, "0")}`;
}

function parseRiskLevel(value: unknown): 0 | 1 {
  if (typeof value === "number" && Number.isInteger(value)) return value === 0 ? 0 : 1;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    if (Number.isInteger(n)) return n === 0 ? 0 : 1;
  }
  return 1;
}

/**
 * Parse an IPN / browser-callback form body. Returns null for malformed
 * payloads (unknown status, missing tran_id) — callers acknowledge-and-
 * ignore those without touching payment state.
 */
export function parseIpnParams(input: unknown): IpnPayload | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const rec = input as Record<string, unknown>;
  const status = asText(rec["status"])?.toUpperCase() ?? null;
  if (!status || !(IPN_STATUSES as readonly string[]).includes(status)) return null;
  const tranId = asText(rec["tran_id"]);
  if (!tranId || tranId.length > 30) return null;
  const rawAmount = asText(rec["amount"]);
  return {
    status: status as IpnStatus,
    tranId,
    valId: asText(rec["val_id"]),
    amountMinor: rawAmount === null ? null : toMinorUnits(rawAmount),
    currency: asText(rec["currency"]) ?? asText(rec["currency_type"]),
    riskLevel: parseRiskLevel(rec["risk_level"]),
    rawAmount,
  };
}

export interface ValidationResult {
  status: string;
  tranId: string | null;
  valId: string | null;
  amountMinor: number | null;
  currency: string | null;
  riskLevel: 0 | 1;
}

/** Parse an Order Validation API response (tolerant — garbage yields null). */
export function parseValidationResponse(payload: unknown): ValidationResult | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const rec = payload as Record<string, unknown>;
  const status = asText(rec["status"])?.toUpperCase() ?? null;
  if (!status) return null;
  const rawAmount = asText(rec["amount"]);
  return {
    status,
    tranId: asText(rec["tran_id"]),
    valId: asText(rec["val_id"]),
    amountMinor: rawAmount === null ? null : toMinorUnits(rawAmount),
    currency: asText(rec["currency"]) ?? asText(rec["currency_type"]),
    riskLevel: parseRiskLevel(rec["risk_level"]),
  };
}

/** Accept only the documented success states (first or repeat validation). */
export function validationAccepts(result: ValidationResult | null): boolean {
  if (!result) return false;
  return (VALIDATION_OK_STATUSES as readonly string[]).includes(result.status);
}

export interface SessionInitResponse {
  ok: boolean;
  sessionKey: string | null;
  gatewayPageURL: string | null;
  failedReason: string | null;
}

/** Parse a session-init response; anything without SUCCESS + URL fails. */
export function parseInitResponse(payload: unknown): SessionInitResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, sessionKey: null, gatewayPageURL: null, failedReason: "Unexpected gateway response." };
  }
  const rec = payload as Record<string, unknown>;
  const status = asText(rec["status"])?.toUpperCase() ?? "";
  const gatewayPageURL = asText(rec["GatewayPageURL"]);
  const sessionKey = asText(rec["sessionkey"]);
  if (status === "SUCCESS" && gatewayPageURL && sessionKey) {
    return { ok: true, sessionKey, gatewayPageURL, failedReason: null };
  }
  return {
    ok: false,
    sessionKey: null,
    gatewayPageURL: null,
    failedReason: asText(rec["failedreason"]) ?? "Payment initiation was rejected by the gateway.",
  };
}

/** Gateway transaction id: `LF-` + 20 hex chars (23 chars, ≤30 per docs). */
export function newTranId(randomHex: string): string {
  const hex = randomHex.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 20).padEnd(20, "0");
  return `LF-${hex}`;
}

/** Invoice number derived from the unique tran_id (unique by construction). */
export function invoiceNumberFor(tranId: string): string {
  return `INV-${tranId}`;
}
