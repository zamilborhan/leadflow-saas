import { NextResponse } from "next/server";
import { env } from "@/src/lib/env";
import { handleWebhookDelivery } from "@/src/lib/integrations/meta/webhook";
import { verifyHandshake, verifyWebhookSignature } from "@/src/lib/integrations/meta/webhook-verify";

/**
 * Meta Lead Ads webhook endpoint (public — Meta holds no session).
 *
 * GET: subscription verification handshake per Meta's webhooks docs:
 * echo hub.challenge iff hub.mode=subscribe and the verify token matches.
 *
 * POST: signed leadgen deliveries. The signature is verified over the RAW
 * body with the app secret; failures are rejected before parsing. Valid
 * batches are stored + processed idempotently and always acknowledged
 * with 200 (Meta's redeliveries double as the retry transport).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const challenge = verifyHandshake(
    url.searchParams.get("hub.mode"),
    url.searchParams.get("hub.verify_token"),
    url.searchParams.get("hub.challenge"),
    env.metaWebhookVerifyToken
  );
  if (challenge === null) {
    return NextResponse.json({ error: "Webhook verification failed." }, { status: 403 });
  }
  return new NextResponse(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(req: Request) {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: "Unreadable request body." }, { status: 400 });
  }
  let validSignature = false;
  try {
    validSignature = await verifyWebhookSignature(
      rawBody,
      req.headers.get("x-hub-signature-256"),
      env.metaAppSecret
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 403 });
  }
  let payload: unknown = null;
  try {
    payload = rawBody.length > 0 ? (JSON.parse(rawBody) as unknown) : null;
  } catch {
    return NextResponse.json({ error: "Malformed webhook payload." }, { status: 400 });
  }
  const summary = await handleWebhookDelivery(payload);
  return NextResponse.json({ ok: true, ...summary }, { status: 200 });
}
