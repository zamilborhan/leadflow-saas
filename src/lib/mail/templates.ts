/**
 * Email bodies for auth flows. Plain text is authoritative (deliverability);
 * HTML mirrors it minimally.
 */
import { env } from "../env";

function linkLine(url: string): string {
  return url;
}

export function verificationMail(to: string, url: string): {
  to: string;
  subject: string;
  text: string;
  html: string;
} {
  return {
    to,
    subject: "Verify your LeadFlow email",
    text: [
      "Welcome to LeadFlow BD!",
      "",
      "Please verify your email address by opening this link (expires in 24 hours):",
      linkLine(url),
      "",
      "If you did not create this account, you can ignore this email.",
    ].join("\n"),
    html: `<p>Welcome to LeadFlow BD!</p><p><a href="${url}">Verify your email address</a> (expires in 24 hours).</p><p>If you did not create this account, you can ignore this email.</p>`,
  };
}

export function resetMail(to: string, url: string): {
  to: string;
  subject: string;
  text: string;
  html: string;
} {
  return {
    to,
    subject: "Reset your LeadFlow password",
    text: [
      "We received a password reset request for your LeadFlow account.",
      "",
      "Open this link to choose a new password (expires in 1 hour, single-use):",
      linkLine(url),
      "",
      "If you did not request this, you can ignore this email.",
    ].join("\n"),
    html: `<p>We received a password reset request for your LeadFlow account.</p><p><a href="${url}">Choose a new password</a> (expires in 1 hour, single-use).</p><p>If you did not request this, you can ignore this email.</p>`,
  };
}

export function verificationUrl(token: string): string {
  return `${env.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
}

export function resetUrl(token: string): string {
  return `${env.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
}
