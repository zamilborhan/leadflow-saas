import { NextResponse } from "next/server";
import { env } from "@/src/lib/env";
import { findPaymentByTranIdPublic } from "@/src/lib/integrations/sslcommerz/service";

export const dynamic = "force-dynamic";

const OUTCOMES = ["success", "fail", "cancel"] as const;
type Outcome = (typeof OUTCOMES)[number];

type Params = { params: Promise<{ outcome: string }> };

/**
 * Browser return URLs (success / fail / cancel). SSLCommerz redirects the
 * customer's browser here after payment — per the v4 integration model
 * this data arrives via the customer and MUST NOT be trusted.
 *
 * These handlers never read the payload for decisions and never write
 * payment state: they resolve the workspace for a friendly redirect and
 * let the billing page render the authoritative server-side records.
 * Subscription activation happens exclusively in the IPN handler after a
 * server-side Order Validation API call.
 */
async function redirectFor(outcome: Outcome, req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const tranId = url.searchParams.get("tran_id")?.trim() || null;
  let businessId: string | null = null;
  if (tranId) {
    try {
      const payment = await findPaymentByTranIdPublic(tranId);
      businessId = payment?.businessId ?? null;
    } catch {
      businessId = null;
    }
  }
  const base = env.nextAuthUrl.replace(/\/$/, "");
  const target = new URL("/dashboard/settings/billing", base);
  if (businessId) target.searchParams.set("businessId", businessId);
  target.searchParams.set("payment", outcome);
  if (tranId) target.searchParams.set("tran_id", tranId);
  return NextResponse.redirect(target.toString(), { status: 303 });
}

function isOutcome(value: string): value is Outcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

export async function GET(req: Request, { params }: Params) {
  const { outcome } = await params;
  if (!isOutcome(outcome)) {
    return NextResponse.json({ error: "Unknown callback." }, { status: 404 });
  }
  return redirectFor(outcome, req);
}

export async function POST(req: Request, { params }: Params) {
  const { outcome } = await params;
  if (!isOutcome(outcome)) {
    return NextResponse.json({ error: "Unknown callback." }, { status: 404 });
  }
  return redirectFor(outcome, req);
}
