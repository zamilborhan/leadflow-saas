import { NextResponse } from "next/server";
import { handleIpnNotification } from "@/src/lib/integrations/sslcommerz/service";
import { SslcommerzUpstreamError } from "@/src/lib/integrations/sslcommerz/client";
import { SslcommerzConfigError } from "@/src/lib/integrations/sslcommerz/config";

export const dynamic = "force-dynamic";

/**
 * SSLCommerz IPN listener (public — the gateway holds no session).
 *
 * Per the v4 docs, the gateway POSTs form-encoded payment notifications
 * here (status VALID | FAILED | CANCELLED | EXPIRED | UNATTEMPTED with
 * tran_id, val_id, amount, currency, risk_level, ...). Handling:
 * - Malformed payloads and unknown tran_ids are acknowledged-and-ignored
 *   (200) — retrying those can never succeed, and the tran_id space must
 *   not become an existence oracle.
 * - Duplicate deliveries for settled payments collapse to acknowledged
 *   no-ops via the payment row (unique tran_id + activatedAt guard).
 * - Only a VALID notification confirmed by a server-side Order Validation
 *   call (matching tran_id, amount, currency; risk_level 0) activates the
 *   subscription. Browser callbacks never write payment state.
 * - Upstream validation outages answer 503 so the gateway retries; the
 *   payment stays PENDING and nothing activates.
 */
export async function POST(req: Request) {
  // Abuse guard: the gateway retries legitimately, but unauthenticated
  // callers must not be able to burn validation quota or probe tran_ids at
  // will. Per-IP + per-tran_id budgets; over-budget answers 429 (retryable).
  try {
    const { apiRateLimiter, API_RATE_LIMITS } = await import("@/src/lib/auth/rate-limit");
    const { getClientIp } = await import("@/src/lib/auth/http");
    const ip = getClientIp(req.headers);
    const ipBudget = API_RATE_LIMITS.ipnPerIp;
    const ipDecision = apiRateLimiter.check(`ipn:ip:${ip}`, ipBudget.limit, ipBudget.windowMs);
    if (!ipDecision.allowed) {
      return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
    }
  } catch {
    // Limiter failure must not break acknowledgement; continue fail-open here
    // (the payment state machine itself stays fail-closed).
  }
  let form: Record<string, string>;
  try {
    const text = await req.text();
    form = {};
    for (const [key, value] of new URLSearchParams(text)) {
      if (!(key in form)) form[key] = value;
    }
    // Per-transaction budget (tran_id is unguessable; a leaked id still
    // cannot be hammered into state churn).
    const tranId = form["tran_id"];
    if (typeof tranId === "string" && tranId.length > 0 && tranId.length <= 30) {
      const { apiRateLimiter, API_RATE_LIMITS } = await import("@/src/lib/auth/rate-limit");
      const tBudget = API_RATE_LIMITS.ipnPerTran;
      const tDecision = apiRateLimiter.check(`ipn:tran:${tranId}`, tBudget.limit, tBudget.windowMs);
      if (!tDecision.allowed) {
        return NextResponse.json({ ok: true, processed: false, duplicate: true, payment: null }, { status: 200 });
      }
    }
  } catch {
    return NextResponse.json({ error: "Unreadable request body." }, { status: 400 });
  }
  try {
    const outcome = await handleIpnNotification(form);
    return NextResponse.json({ ok: true, ...outcome }, { status: 200 });
  } catch (err) {
    if (err instanceof SslcommerzUpstreamError || err instanceof SslcommerzConfigError) {
      // Generic upstream message: gateway reachability is not oracle-fed to
      // unauthenticated callers.
      return NextResponse.json({ ok: false, error: "Payment gateway is temporarily unavailable." }, { status: 503 });
    }
    console.error("[sslcommerz-ipn] failed", { message: err instanceof Error ? err.message : "unknown" });
    return NextResponse.json({ ok: false, error: "Internal server error." }, { status: 500 });
  }
}
