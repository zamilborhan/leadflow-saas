import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { getRecentActivity } from "@/src/lib/admin/activity";

/**
 * Compact recent-activity list. Streams in via Suspense after the KPI
 * cards; plain empty/error text, no client JavaScript.
 */
export async function RecentActivity(): Promise<React.JSX.Element> {
  const events = await getRecentActivity(8).catch(() => null);
  if (!events) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">
            Unable to load activity.{" "}
            <Link href="/admin" className="font-semibold text-brand-700 hover:underline">
              Retry
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
        <CardDescription>
          Latest platform events ·{" "}
          <Link href="/admin/activity" className="font-semibold text-brand-700 hover:underline">
            View all →
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">No recent activity</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {events.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800">{e.title}</p>
                  {e.detail ? <p className="truncate text-xs text-slate-400">{e.detail}</p> : null}
                </div>
                <span className="shrink-0 text-[11px] text-slate-400">{e.createdAt.slice(5, 10)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
