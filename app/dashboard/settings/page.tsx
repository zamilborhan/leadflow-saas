import { GeneralSettingsForm } from "./general-form";

export const metadata = {
  title: "General settings — LeadFlow BD",
};

/** Workspace general settings: business profile form. */
export default function GeneralSettingsPage() {
  return (
    <div className="max-w-2xl">
      <GeneralSettingsForm />
    </div>
  );
}
