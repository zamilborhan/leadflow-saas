import { requireUserForPage } from "@/src/lib/auth/dal";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { listUserBusinesses } from "@/src/lib/tenancy/businesses";
import { hasPermission } from "@/src/lib/tenancy/roles";
import { getMetaConnectionStatus } from "@/src/lib/integrations/meta/service";
import { getMetaSelection } from "@/src/lib/integrations/meta/pages";
import { getWhatsAppStatus } from "@/src/lib/integrations/whatsapp/service";
import { listTemplates } from "@/src/lib/integrations/whatsapp/templates";
import { Card } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { MetaConnectionCard } from "./meta-connection-card";
import { MetaPagesFormsCard } from "./meta-pages-forms-card";
import { MetaResultToast } from "./meta-result-toast";
import { WhatsAppConnectionCard } from "./whatsapp-connection-card";
import { WhatsAppTemplatesCard } from "./whatsapp-templates-card";

export const metadata = {
  title: "Integrations settings — LeadFlow BD",
};

/**
 * Workspace integrations. Resolves the current business, loads the
 * redacted Meta connection status server-side, and renders management
 * controls gated by businesses.update (OWNER/ADMIN).
 */
export default async function IntegrationsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUserForPage();
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const businessId = first(params["businessId"]) ?? null;
  const metaFlag = first(params["meta"]) ?? null;

  const businesses = await listUserBusinesses(user.id).catch(() => []);
  if (businesses.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No workspace yet"
          description="Create a workspace before connecting integrations."
        />
      </Card>
    );
  }
  let resolved = businessId ? await resolveBusinessContext(user.id, businessId) : null;
  if (!resolved?.ok) {
    const retry = await resolveBusinessContext(user.id, businesses[0].id);
    if (!retry.ok) {
      return (
        <Card>
          <EmptyState
            title="No workspace yet"
            description="Create a workspace before connecting integrations."
          />
        </Card>
      );
    }
    resolved = retry;
  }
  const { business, membership } = resolved.context;
  const status = await getMetaConnectionStatus(resolved.context).catch(() => ({ connected: false }));
  const selection = await getMetaSelection(resolved.context).catch(() => ({ page: null, form: null }));
  const waStatus = await getWhatsAppStatus(resolved.context).catch(() => ({ connected: false }));
  const waTemplates = await listTemplates(resolved.context).catch(() => []);
  const canManage = hasPermission(membership.role, "businesses.update");

  return (
    <div className="flex flex-col gap-6">
      <MetaResultToast flag={metaFlag} />
      <PageHeader
        title="Integrations"
        description={`External connections for ${business.name}.`}
      />
      <div className="flex max-w-2xl flex-col gap-6">
        <MetaConnectionCard businessId={business.id} initial={status} selection={selection} canManage={canManage} />
        {status.connected ? (
          <MetaPagesFormsCard businessId={business.id} canManage={canManage} initial={selection} />
        ) : null}
        <WhatsAppConnectionCard businessId={business.id} initial={waStatus} canManage={canManage} />
        <WhatsAppTemplatesCard businessId={business.id} canManage={canManage} initial={waTemplates} />
      </div>
    </div>
  );
}
