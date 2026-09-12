import { requireUserForPage } from "@/src/lib/auth/dal";
import { listUserBusinesses } from "@/src/lib/tenancy/businesses";
import { DashboardShell } from "@/src/components/layout/dashboard-shell";

/** Protected dashboard section: sidebar + header chrome for all child pages. */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUserForPage();
  const businesses = await listUserBusinesses(user.id).catch(() => []);
  return (
    <DashboardShell
      userEmail={user.email}
      avatarUrl={user.avatarUrl ?? null}
      businesses={businesses.map((b) => ({ id: b.id, name: b.name }))}
    >
      {children}
    </DashboardShell>
  );
}
