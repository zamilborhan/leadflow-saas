import { SettingsShell } from "@/src/components/layout/settings-shell";

/** Settings section layout: tabbed shell shared by all settings pages. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>;
}
