import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";

export const metadata = { title: "Settings — Super-admin — LeadFlow BD" };

function row(label: string, value: string, sensitive: boolean): { label: string; value: string; sensitive: boolean } {
  return { label, value, sensitive };
}

/**
 * Centralized platform settings (read-only status board).
 * Secrets stay server-side: only configured/unset is shown, never values.
 * Writes require a SystemSetting table + restart-safe config reload
 * (backend requirement) — no fake toggles that don't persist.
 */
export default async function AdminSettingsPage() {
  await requireSuperAdminForPage("/admin/settings");
  const has = (k: string): boolean => (process.env[k] ?? "").length > 0;
  const general = [
    row("App URL", process.env["APP_URL"] ?? process.env["NEXTAUTH_URL"] ?? "unset", false),
    row("Mail provider", process.env["MAIL_PROVIDER"] ?? "log", false),
    row("Mail from", process.env["MAIL_FROM"] ?? "unset", false),
    row("Support email", process.env["SUPPORT_EMAIL"] ?? "unset (set SUPPORT_EMAIL)", false),
  ];
  const platform = [
    row("Registration", process.env["REGISTRATION_ENABLED"] ?? "enabled (default)", false),
    row("New workspace creation", process.env["WORKSPACE_CREATION_ENABLED"] ?? "enabled (default)", false),
    row("Maintenance mode", process.env["MAINTENANCE_MODE"] ?? "off (default)", false),
  ];
  const secrets = [
    row("DATABASE_URL", has("DATABASE_URL") ? "configured" : "missing", true),
    row("META_APP_ID / SECRET", has("META_APP_ID") && has("META_APP_SECRET") ? "configured" : "incomplete", true),
    row("META_TOKEN_KEY", has("META_TOKEN_KEY") ? "configured" : "missing", true),
    row("SSLCOMMERZ credentials", has("SSLCOMMERZ_STORE_ID") && has("SSLCOMMERZ_STORE_SECRET") ? "configured" : "incomplete", true),
    row("SUPER_ADMIN_EMAILS", has("SUPER_ADMIN_EMAILS") ? "configured" : "empty — no admins", true),
    row("ADMIN/SUPPORT/BILLING/ANALYST_EMAILS", [has("ADMIN_EMAILS"), has("SUPPORT_ADMIN_EMAILS"), has("BILLING_ADMIN_EMAILS"), has("ANALYST_EMAILS")].some(Boolean) ? "at least one role configured" : "none (super-admin only)", true),
  ];

interface SettingRow {
  label: string;
  value: string;
  sensitive: boolean;
}

function renderSection(title: string, description: string, rows: SettingRow[]): React.JSX.Element {
  return (
    <Card key={title}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-slate-100 text-sm">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center justify-between gap-3 py-2">
              <span className="font-medium text-slate-700">{r.label}</span>
              <span className="flex items-center gap-2">
                <span className="max-w-64 truncate text-xs text-slate-500">{r.value}</span>
                {r.sensitive ? <Badge variant="neutral">server-only</Badge> : null}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="System settings" description="Configuration status. Change values in the environment / secrets manager, never in the browser." eyebrow="Super-admin" />
      {renderSection("General", "Public-facing platform identity.", general)}
      {renderSection("Platform gates", "Honor REGISTRATION_ENABLED=false, WORKSPACE_CREATION_ENABLED=false, MAINTENANCE_MODE=true when set.", platform)}
      {renderSection("Secrets & access", "Configured/unset only — values never render.", secrets)}
    </div>
  );
}
