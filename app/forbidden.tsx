import { ForbiddenView } from "@/src/components/admin/forbidden-view";

export const metadata = { title: "Forbidden — LeadFlow BD" };

/**
 * Root 403 boundary. Catches `forbidden()` thrown from segment layouts
 * (e.g. app/admin/layout.tsx), which propagate past their own segment.
 */
export default function RootForbidden() {
  return <ForbiddenView />;
}
