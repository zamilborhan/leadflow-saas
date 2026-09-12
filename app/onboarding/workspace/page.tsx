import { redirect } from "next/navigation";
import { AuthLayout } from "@/src/components/layout/auth-layout";
import { requireUserForPage } from "@/src/lib/auth/dal";
import { listUserBusinesses } from "@/src/lib/tenancy/businesses";
import { CreateWorkspaceForm } from "./workspace-form";

export const metadata = {
  title: "Create workspace — LeadFlow BD",
};

/**
 * Onboarding: signed-in users with no workspace land here after login,
 * registration, or OAuth. Users who already own one go to the dashboard.
 */
export default async function CreateWorkspacePage() {
  const user = await requireUserForPage();
  const businesses = await listUserBusinesses(user.id).catch(() => []);
  if (businesses.length > 0) redirect("/dashboard");

  return (
    <AuthLayout
      title="Create workspace"
      subtitle="Your business gets its own isolated pipeline, team, and settings."
      footer={
        <>
          Wrong account?{" "}
          <a href="/login" className="font-medium text-brand-700 hover:text-brand-800">
            Switch account
          </a>
        </>
      }
    >
      <CreateWorkspaceForm />
    </AuthLayout>
  );
}
