import { ForbiddenView } from "@/src/components/admin/forbidden-view";

export const metadata = { title: "Forbidden — Super-admin — LeadFlow BD" };

/**
 * Segment 403 boundary. Catches `forbidden()` thrown from /admin pages
 * (each page authorizes via `requireSuperAdminForPage` before fetching).
 */
export default function AdminForbidden() {
  return <ForbiddenView />;
}
