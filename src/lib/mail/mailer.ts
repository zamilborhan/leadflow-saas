/**
 * Outbound email for LeadFlow BD (verification + password reset).
 *
 * Providers (env `MAIL_PROVIDER`, default `log`):
 * - `log`: prints to server logs. Local-dev default, no credentials needed.
 * - `resend`: POSTs to api.resend.com (needs `RESEND_API_KEY`).
 *
 * Framework-free so services and tests use it directly. Never throws for
 * logging failures; throws only when the `resend` transport fails so callers
 * can decide (auth flows still return generic success to avoid enumeration).
 */
import { env } from "../env";

export interface SendMailInput {
  to: string;
  subject: string;
  /** Plain-text fallback (required for deliverability). */
  text: string;
  /** Optional HTML body. */
  html?: string;
}

export async function sendMail(input: SendMailInput): Promise<void> {
  const provider = env.mailProvider.toLowerCase();
  if (provider === "resend") {
    await sendViaResend(input);
    return;
  }
  // Default `log` provider (also covers unknown values fail-safe).
  // Never log token-bearing bodies: verification/reset URLs contain
  // single-use secrets that would turn log retention into a credential
  // store. Operators get routing metadata only.
  console.log("[mail] send", {
    provider: "log",
    to: input.to,
    subject: input.subject,
  });
}

async function sendViaResend(input: SendMailInput): Promise<void> {
  const apiKey = env.resendApiKey;
  if (!apiKey) throw new Error("[mail] MAIL_PROVIDER=resend but RESEND_API_KEY is missing");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.mailFrom,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[mail] resend failed: ${res.status} ${body.slice(0, 200)}`);
  }
}
