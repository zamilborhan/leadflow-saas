/**
 * SSLCommerz payment service (server-only).
 *
 * Security contract (mirrors the Meta/WhatsApp services):
 * - Credentials come only from `env.ts` (server-only env vars) and travel
 *   solely in server-to-server POST bodies. They are never logged, never
 *   returned in DTOs, never sent to clients, and never stringified into
 *   thrown errors.
 * - Amounts and plans are re-derived server-side from the static catalog
 *   and our own Payment/Invoice rows. Request fields (including IPN
 *   fields and browser query strings) never set money or plans.
 * - Subscription activation happens ONLY here, after a successful
 *   server-side Order Validation API call with matching tran_id, amount,
 *   and currency. Browser success callbacks only redirect — they never
 *   write payment state.
 * - Idempotency: `tranId` is unique; re-entrant processing is guarded by
 *   the payment row (`activatedAt` + terminal statuses), so duplicate IPN
 *   replays and double validation calls collapse to acknowledged no-ops.
 *
 * Tenant isolation: every read/write carries the routed `businessId`;
 * unknown tran_ids resolve to ignored (no oracle into other workspaces).
 */

import crypto from "node:crypto";
import { InvoiceTable, PaymentTable } from "../../../prisma/tables";
import { env } from "../../env";
import type { BusinessContext } from "../../tenancy/context";
import { requireRole, TenantConflict } from "../../tenancy/policies";
import { findUserById } from "../../auth/users";
import { toBusinessId, toDbId } from "../../tenancy/businesses";
import { emitPaymentFailed } from "../../tenancy/notifications";
import { applyPaidActivation } from "../../billing/subscriptions";
import { PLANS, isValidPlanCode, type PlanCode } from "../../billing/catalog";
import { sslcommerzConfig } from "./config";
import { SSLCommerzClient, SslcommerzUpstreamError, SSLCommerzError } from "./client";
import {
  formatMinorBdt,
  invoiceNumberFor,
  newTranId,
  parseInitResponse,
  parseIpnParams,
  parseValidationResponse,
  toDecimalString,
  validationAccepts,
  type IpnPayload,
} from "./payloads";

export type PaymentStatus =
  | "INITIATED"
  | "PENDING"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED"
  | "RISK_HOLD";

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
]);

export interface PaymentDTO {
  id: string;
  businessId: string;
  userId: string;
  planCode: string;
  amountMinor: number;
  currency: string;
  tranId: string;
  valId: string | null;
  status: PaymentStatus;
  riskLevel: number;
  lastError: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceDTO {
  id: string;
  businessId: string;
  paymentId: string;
  invoiceNumber: string;
  planCode: string;
  amountMinor: number;
  currency: string;
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

const PAYMENT_FIELDS = [
  "id",
  "businessId",
  "userId",
  "planCode",
  "amountMinor",
  "currency",
  "tranId",
  "valId",
  "status",
  "gatewaySessionKey",
  "riskLevel",
  "lastError",
  "activatedAt",
  "createdAt",
  "updatedAt",
] as const;

const INVOICE_FIELDS = [
  "id",
  "businessId",
  "paymentId",
  "invoiceNumber",
  "planCode",
  "amountMinor",
  "currency",
  "status",
  "periodStart",
  "periodEnd",
  "createdAt",
  "updatedAt",
] as const;

type PaymentRow = {
  id: string;
  businessId: string;
  userId: string;
  planCode: string;
  amountMinor: number;
  currency: string;
  tranId: string;
  valId: string | null;
  status: string;
  gatewaySessionKey: string | null;
  riskLevel: number;
  lastError: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type InvoiceRow = {
  id: string;
  businessId: string;
  paymentId: string;
  invoiceNumber: string;
  planCode: string;
  amountMinor: number;
  currency: string;
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
  updatedAt: string;
};

function toPaymentDTO(row: PaymentRow): PaymentDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    userId: row.userId,
    planCode: row.planCode,
    amountMinor: row.amountMinor,
    currency: row.currency,
    tranId: row.tranId,
    valId: row.valId,
    status: row.status as PaymentStatus,
    riskLevel: row.riskLevel,
    lastError: row.lastError,
    activatedAt: row.activatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toInvoiceDTO(row: InvoiceRow): InvoiceDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    paymentId: row.paymentId,
    invoiceNumber: row.invoiceNumber,
    planCode: row.planCode,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Unknown payment error.";
  return message.slice(0, 500);
}

async function findPaymentByTranId(tranId: string): Promise<PaymentRow | null> {
  const rows = await PaymentTable.where((p) => p.tranId.eq(tranId))
    .select(...PAYMENT_FIELDS)
    .all();
  return rows[0] ?? null;
}

async function setPayment(
  id: string,
  patch: Partial<Pick<PaymentRow, "status" | "valId" | "gatewaySessionKey" | "riskLevel" | "lastError" | "activatedAt">>
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.status !== undefined) update["status"] = patch.status;
  if (patch.valId !== undefined) update["valId"] = patch.valId;
  if (patch.gatewaySessionKey !== undefined) update["gatewaySessionKey"] = patch.gatewaySessionKey;
  if (patch.riskLevel !== undefined) update["riskLevel"] = patch.riskLevel;
  if (patch.lastError !== undefined) update["lastError"] = patch.lastError;
  if (patch.activatedAt !== undefined) update["activatedAt"] = patch.activatedAt;
  await PaymentTable.where({ id: toDbId(id) }).update(update as never);
}

async function setInvoice(
  id: string,
  patch: Partial<Pick<InvoiceRow, "status" | "periodStart" | "periodEnd">>
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.status !== undefined) update["status"] = patch.status;
  if (patch.periodStart !== undefined) update["periodStart"] = patch.periodStart;
  if (patch.periodEnd !== undefined) update["periodEnd"] = patch.periodEnd;
  await InvoiceTable.where({ id: toDbId(id) }).update(update as never);
}

async function findInvoiceByPayment(businessId: string, paymentId: string): Promise<InvoiceRow | null> {
  const bid = toBusinessId(businessId);
  const rows = await InvoiceTable.where((i) => i.businessId.eq(bid))
    .select(...INVOICE_FIELDS)
    .all();
  return rows.find((r) => r.paymentId === paymentId) ?? null;
}

export interface CheckoutResult {
  payment: PaymentDTO;
  invoice: InvoiceDTO;
  gatewayUrl: string;
  tranId: string;
}

/**
 * Start a paid-plan checkout. OWNER-only. Amount, currency, and callback
 * URLs are derived server-side; the only caller-controlled input is the
 * plan code. FREE has no price — downgrades stay on the subscription
 * settings flow.
 */
export async function initiateCheckout(
  context: BusinessContext,
  planCode: string,
  opts?: { client?: SSLCommerzClient; appUrl?: string; nowMs?: number }
): Promise<CheckoutResult> {
  requireRole(context, "OWNER");
  if (!isValidPlanCode(planCode)) {
    throw new TenantConflict(`Unknown plan: ${planCode}.`);
  }
  const plan = PLANS[planCode as PlanCode];
  if (plan.priceMinor <= 0) {
    throw new TenantConflict("The Free plan needs no payment — change plans in subscription settings.");
  }
  const config = sslcommerzConfig(process.env);
  const client = opts?.client ?? new SSLCommerzClient({ baseUrl: config.baseUrl });
  const appUrl = (opts?.appUrl ?? env.nextAuthUrl).replace(/\/$/, "");

  const tranId = newTranId(crypto.randomBytes(16).toString("hex"));
  const user = await findUserById(context.membership.userId).catch(() => null);
  const customerName = (user?.name ?? user?.email.split("@")[0] ?? "Customer").slice(0, 50);
  const customerEmail = (user?.email ?? "").slice(0, 50);

  const bid = toBusinessId(context.business.id);
  const paymentRow = await PaymentTable.select(...PAYMENT_FIELDS).create({
    businessId: bid,
    userId: toDbId(context.membership.userId),
    planCode: plan.code,
    amountMinor: plan.priceMinor,
    currency: plan.currency,
    tranId,
    status: "INITIATED",
  });
  const invoiceRow = await InvoiceTable.select(...INVOICE_FIELDS).create({
    businessId: bid,
    paymentId: toDbId(paymentRow.id),
    invoiceNumber: invoiceNumberFor(tranId),
    planCode: plan.code,
    amountMinor: plan.priceMinor,
    currency: plan.currency,
    status: "DRAFT",
  });

  const initParams: Record<string, string> = {
    store_id: config.storeId,
    store_passwd: config.storeSecret,
    total_amount: toDecimalString(plan.priceMinor),
    currency: plan.currency,
    tran_id: tranId,
    success_url: `${appUrl}/api/payments/callback/success?tran_id=${tranId}`,
    fail_url: `${appUrl}/api/payments/callback/fail?tran_id=${tranId}`,
    cancel_url: `${appUrl}/api/payments/callback/cancel?tran_id=${tranId}`,
    ipn_url: `${appUrl}/api/webhooks/sslcommerz/ipn`,
    product_category: "subscription",
    product_name: `${plan.name} Plan — LeadFlow BD`,
    product_profile: "non-physical-goods",
    cus_name: customerName,
    cus_email: customerEmail,
    cus_add1: "Dhaka",
    cus_city: "Dhaka",
    cus_postcode: "1000",
    cus_country: "Bangladesh",
    cus_phone: "01700000000",
    shipping_method: "NO",
    num_of_item: "1",
    value_a: context.business.id,
    value_b: plan.code,
  };
  let initPayload: unknown;
  try {
    initPayload = await client.initSession(initParams);
  } catch (err) {
    const message = err instanceof SslcommerzUpstreamError ? err.message : sanitizeError(err);
    await setPayment(paymentRow.id, { status: "FAILED", lastError: message });
    throw err instanceof SSLCommerzError ? err : new SSLCommerzError(message);
  }
  const parsed = parseInitResponse(initPayload);
  if (!parsed.ok || !parsed.gatewayPageURL || !parsed.sessionKey) {
    await setPayment(paymentRow.id, {
      status: "FAILED",
      lastError: (parsed.failedReason ?? "Payment initiation was rejected.").slice(0, 500),
    });
    throw new SSLCommerzError(parsed.failedReason ?? "Payment initiation was rejected by the gateway.");
  }
  await setPayment(paymentRow.id, { status: "PENDING", gatewaySessionKey: parsed.sessionKey });
  const payment = toPaymentDTO({ ...(paymentRow as PaymentRow), status: "PENDING", gatewaySessionKey: parsed.sessionKey });
  return { payment, invoice: toInvoiceDTO(invoiceRow as InvoiceRow), gatewayUrl: parsed.gatewayPageURL, tranId };
}

export interface IpnOutcome {
  /** True when a state transition was recorded. */
  processed: boolean;
  /** True when this delivery changed nothing (unknown, duplicate). */
  duplicate: boolean;
  payment: PaymentDTO | null;
}

/**
 * Handle one IPN / server callback delivery. Always safe to acknowledge:
 * unknown or malformed payloads are ignored without touching state, and
 * duplicate deliveries for settled payments collapse to no-ops.
 *
 * Activation rule: only a `VALID` notification whose server-side Order
 * Validation call returns VALID/VALIDATED with matching tran_id, amount,
 * and currency — and risk_level 0 — activates the subscription.
 */
export async function handleIpnNotification(
  form: Record<string, string>,
  opts?: { client?: SSLCommerzClient; nowMs?: number }
): Promise<IpnOutcome> {
  const payload: IpnPayload | null = parseIpnParams(form);
  if (!payload) return { processed: false, duplicate: false, payment: null };

  const stored = await findPaymentByTranId(payload.tranId);
  if (!stored || stored.businessId == null) {
    return { processed: false, duplicate: false, payment: null };
  }
  const businessId = stored.businessId;
  const payment = toPaymentDTO(stored);

  // Duplicate protection: an already-activated payment never re-activates,
  // and terminal states never move except via a fresh checkout.
  if (payment.activatedAt) {
    return { processed: false, duplicate: true, payment };
  }
  if (TERMINAL_STATUSES.has(payment.status)) {
    return { processed: false, duplicate: true, payment };
  }

  if (payload.status !== "VALID") {
    // Security note: non-VALID IPNs carry no val_id, so server-side Order
    // Validation cannot confirm them. The gateway signs no stable local
    // field for these statuses, so authenticity rests on the unguessable
    // tran_id (LF- + 80-bit random, never enumerated) plus per-IP /
    // per-tran rate limits at the route. Only PENDING/INITIATED payments
    // move; terminal rows never regress. UNATTEMPTED (user never paid)
    // maps explicitly to EXPIRED.
    const mapped =
      payload.status === "CANCELLED"
        ? "CANCELLED"
        : payload.status === "FAILED"
          ? "FAILED"
          : "EXPIRED";
    await setPayment(payment.id, { status: mapped as PaymentStatus, lastError: `Gateway reported ${payload.status}.` });
    const invoice = await findInvoiceByPayment(businessId, payment.id);
    if (invoice && invoice.status === "DRAFT") {
      await setInvoice(invoice.id, { status: "VOID" });
    }
    if (mapped === "FAILED") {
      try {
        await emitPaymentFailed(businessId, {
          reference: payment.tranId,
          amount: formatMinorBdt(payment.amountMinor),
          detail: `Payment for the ${payment.planCode} plan failed at the gateway.`,
        });
      } catch {
        // Notification failure must not break webhook acknowledgement.
      }
    }
    const updated = await findPaymentByTranId(payload.tranId);
    return { processed: true, duplicate: false, payment: updated ? toPaymentDTO(updated) : payment };
  }

  // VALID path: a val_id is mandatory — without it there is nothing the
  // validation API could confirm, so this is terminal tamper/rot, not retryable.
  if (!payload.valId) {
    await setPayment(payment.id, { status: "FAILED", lastError: "VALID notification without a validation id." });
    return { processed: true, duplicate: false, payment: toPaymentDTO({ ...stored, status: "FAILED" }) };
  }

  const config = sslcommerzConfig(process.env);
  const client = opts?.client ?? new SSLCommerzClient({ baseUrl: config.baseUrl });
  let validationPayload: unknown;
  try {
    validationPayload = await client.validateOrder({
      valId: payload.valId,
      storeId: config.storeId,
      storePasswd: config.storeSecret,
    });
  } catch (err) {
    // Upstream outage: leave the payment PENDING and ask the gateway to
    // retry by answering 503 (handled in the route).
    if (err instanceof SslcommerzUpstreamError) throw err;
    await setPayment(payment.id, { status: "FAILED", lastError: sanitizeError(err) });
    throw err instanceof SSLCommerzError ? err : new SSLCommerzError(sanitizeError(err));
  }
  const validation = parseValidationResponse(validationPayload);
  const matches =
    validationAccepts(validation) &&
    validation!.tranId === payment.tranId &&
    validation!.amountMinor === payment.amountMinor &&
    (validation!.currency ?? "").toUpperCase() === payment.currency.toUpperCase();

  if (!matches) {
    await setPayment(payment.id, {
      status: "FAILED",
      valId: payload.valId,
      lastError: "Server-side validation failed: tran_id, amount, or currency mismatch.",
    });
    try {
      await emitPaymentFailed(businessId, {
        reference: payment.tranId,
        amount: formatMinorBdt(payment.amountMinor),
        detail: "A payment callback failed server-side verification and was rejected.",
      });
    } catch {
      // Notification failure must not break webhook acknowledgement.
    }
    const updated = await findPaymentByTranId(payload.tranId);
    return { processed: true, duplicate: false, payment: updated ? toPaymentDTO(updated) : payment };
  }

  const riskLevel = validation!.riskLevel;
  if (riskLevel === 1) {
    await setPayment(payment.id, { status: "RISK_HOLD", valId: payload.valId, riskLevel: 1 });
    try {
      await emitPaymentFailed(businessId, {
        reference: payment.tranId,
        amount: formatMinorBdt(payment.amountMinor),
        detail: "Payment is held for manual review (gateway flagged high risk).",
      });
    } catch {
      // Notification failure must not break webhook acknowledgement.
    }
    const updated = await findPaymentByTranId(payload.tranId);
    return { processed: true, duplicate: false, payment: updated ? toPaymentDTO(updated) : payment };
  }

  // Success: record, then re-verify the row BEFORE activating so racing
  // duplicate deliveries cannot double-extend the subscription. The row is
  // terminal (SUCCESS) from here on, so late racers collapse at the top
  // guard; this second read closes the remaining race between two
  // concurrent deliveries that both passed the pre-check.
  await setPayment(payment.id, { status: "SUCCESS", valId: payload.valId, riskLevel: 0, lastError: null });
  const preActivate = await findPaymentByTranId(payload.tranId);
  if (preActivate?.activatedAt) {
    return { processed: false, duplicate: true, payment: toPaymentDTO(preActivate) };
  }
  const invoice = await findInvoiceByPayment(businessId, payment.id);
  const nowMs = opts?.nowMs ?? Date.now();
  if (!isValidPlanCode(payment.planCode)) {
    await setPayment(payment.id, { status: "FAILED", lastError: "Stored plan code is unknown." });
    return { processed: true, duplicate: false, payment };
  }
  const activated = await applyPaidActivation(businessId, payment.planCode, nowMs);
  if (invoice) {
    await setInvoice(invoice.id, {
      status: "PAID",
      periodStart: activated.currentPeriodStart,
      periodEnd: activated.currentPeriodEnd,
    });
  }
  const recheck = await findPaymentByTranId(payload.tranId);
  if (recheck?.activatedAt) {
    return { processed: false, duplicate: true, payment: toPaymentDTO(recheck) };
  }
  await setPayment(payment.id, { activatedAt: new Date(nowMs).toISOString() });
  const updated = await findPaymentByTranId(payload.tranId);
  return { processed: true, duplicate: false, payment: updated ? toPaymentDTO(updated) : payment };
}

/** Single payment scoped to a business (unknown/foreign → null, no oracle). */
export async function getPayment(
  context: BusinessContext,
  paymentId: string
): Promise<PaymentDTO | null> {
  const bid = toBusinessId(context.business.id);
  const rows = await PaymentTable.where((p) => p.businessId.eq(bid))
    .select(...PAYMENT_FIELDS)
    .all();
  const row = rows.find((r) => r.id === paymentId) ?? null;
  return row ? toPaymentDTO(row) : null;
}

/** Payment lookup by gateway id for callback redirects (public by necessity). */
export async function findPaymentByTranIdPublic(tranId: string): Promise<PaymentDTO | null> {
  const row = await findPaymentByTranId(tranId);
  return row ? toPaymentDTO(row) : null;
}

export interface InvoiceHistoryItem extends InvoiceDTO {
  paymentStatus: string;
}

/** Invoice history with payment status, newest first. Membership read. */
export async function listInvoiceHistory(context: BusinessContext): Promise<InvoiceHistoryItem[]> {
  const bid = toBusinessId(context.business.id);
  const [invoices, payments] = await Promise.all([
    InvoiceTable.where((i) => i.businessId.eq(bid))
      .select(...INVOICE_FIELDS)
      .all(),
    PaymentTable.where((p) => p.businessId.eq(bid))
      .select("id", "status")
      .all(),
  ]);
  const statusByPayment = new Map(payments.map((p) => [p.id as string, p.status as string]));
  return invoices
    .map((inv) => ({
      ...toInvoiceDTO(inv as InvoiceRow),
      paymentStatus: statusByPayment.get(inv.paymentId) ?? "UNKNOWN",
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
