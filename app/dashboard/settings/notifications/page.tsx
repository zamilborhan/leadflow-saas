import { NotificationForm } from "./notifications-form";

export const metadata = {
  title: "Notification settings — LeadFlow BD",
};

/** Notification preferences page. */
export default function NotificationSettingsPage() {
  return (
    <div className="max-w-2xl">
      <NotificationForm />
    </div>
  );
}
