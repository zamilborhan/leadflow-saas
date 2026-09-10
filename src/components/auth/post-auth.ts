/**
 * Post-authentication destination shared by email and OAuth flows.
 *
 * Rule: an explicit deep link (`next` other than `/dashboard`) is always
 * respected (recovery and invite flows depend on it). Otherwise the user
 * lands on the dashboard when they own at least one workspace, or on
 * workspace creation when they own none. Fail-open to the preferred page —
 * a workspace-list hiccup must never trap a signed-in user.
 */
export async function resolvePostAuthDestination(preferred: string): Promise<string> {
  if (preferred !== "/dashboard") return preferred;
  try {
    const res = await fetch("/api/businesses", { cache: "no-store" });
    if (!res.ok) return preferred;
    const data = (await res.json()) as { businesses?: unknown };
    const list = Array.isArray(data?.businesses) ? data.businesses : [];
    return list.length > 0 ? preferred : "/create-workspace";
  } catch {
    return preferred;
  }
}
