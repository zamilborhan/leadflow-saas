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
  let form: Record<string, string>;
  try {
    const text = await req.text();
    form = {};
    for (const [key, value] of new URLSearchParams(text)) {
      if (!(key in form)) form[key] = value;
    }
  } catch {
    return NextResponse.json({ error: "Unreadable request body." }, { status: 400 });
  }
  try {
    const outcome = await handleIpnNotification(form);
    return NextResponse.json({ ok: true, ...outcome }, { status: 200 });
  } catch (err) {
    if (err instanceof SslcommerzUpstreamError || err instanceof SslcommerzConfigError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 503 });
    }
    console.error("[sslcommerz-ipn] failed", { message: err instanceof Error ? err.message : "unknown" });
    return NextResponse.json({ ok: false, error: "Internal server error." }, { status: 500 });
  }
}
