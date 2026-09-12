import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { getWorkspaceGrowth } from "@/src/lib/admin/metrics";

const BAR_W = 28;
const GAP = 10;
const CHART_H = 120;

/**
 * Workspace-growth mini-chart. Server-rendered inline SVG — zero client
 * JavaScript, streams in after the KPI cards via Suspense. Source is
 * server-side COUNT aggregates (one number per month), never raw rows.
 */
export async function GrowthChart(): Promise<React.JSX.Element> {
  const series = await getWorkspaceGrowth().catch(() => null);
  if (!series) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Growth</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">
            Unable to load chart.{" "}
            <Link href="/admin" className="font-semibold text-brand-700 hover:underline">
              Retry
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }
  const max = Math.max(...series.map((s) => s.newWorkspaces), 0);
  const width = series.length * (BAR_W + GAP) + GAP;
  const total = series.reduce((a, s) => a + s.newWorkspaces, 0);
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Growth</CardTitle>
        <CardDescription>
          {total} new workspaces · trailing 6 months ·{" "}
          <Link href="/admin/analytics" className="font-semibold text-brand-700 hover:underline">
            Details →
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {max === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">No new workspaces in this period.</p>
        ) : (
          <svg
            viewBox={`0 0 ${width} ${CHART_H + 22}`}
            role="img"
            aria-label="New workspaces per month, trailing 6 months"
            className="w-full"
          >
            {series.map((s, i) => {
              const h = Math.max(s.newWorkspaces > 0 ? 4 : 0, (s.newWorkspaces / max) * CHART_H);
              const x = GAP + i * (BAR_W + GAP);
              const y = CHART_H - h;
              return (
                <g key={s.month}>
                  <title>{`${s.month}: ${s.newWorkspaces} new workspaces`}</title>
                  <rect x={x} y={y} width={BAR_W} height={h} rx={3} className="fill-brand-600" />
                  <text x={x + BAR_W / 2} y={CHART_H + 14} textAnchor="middle" fontSize={9} className="fill-slate-400">
                    {s.month.slice(5)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </CardContent>
    </Card>
  );
}
