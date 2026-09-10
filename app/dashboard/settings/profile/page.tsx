import { ProfileForm } from "./profile-form";

export const metadata = {
  title: "Profile settings — LeadFlow BD",
};

/** Signed-in user's own profile (not workspace-scoped). */
export default function ProfileSettingsPage() {
  return (
    <div className="max-w-2xl">
      <ProfileForm />
    </div>
  );
}
