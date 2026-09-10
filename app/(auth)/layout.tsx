import type { ReactNode } from "react";

export const metadata = {
  title: "Log in — LeadFlow BD",
};

/** Auth route group: (auth) prefix keeps public URLs (/login, /register) unchanged. */
export default function AuthGroupLayout({ children }: { children: ReactNode }) {
  return children;
}
