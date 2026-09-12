import type { ReactNode } from "react";
import { Card, CardContent } from "@/src/components/ui/card";
import { cn } from "@/src/lib/cn";

/**
 * Premium KPI card: clear title, large value, trend indicator,
 * supporting text, subtle icon. One coherent style everywhere.
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  trend,
  tone = "brand",
}: {
  label: string;
  value: string;
  hint: string;
  icon?: ReactNode;
  trend?: { direction: "up" | "down" | "flat"; text: string };
  tone?: "brand" | "success" | "warning" | "danger" | "info" | "neutral";
}) {
  const tones: Record<string, string> = {
    brand: "bg-brand-50 text-brand-600",
    success: "bg-emerald-50 text-emerald-600",
    warning: "bg-amber-50 text-amber-600",
    danger: "bg-red-50 text-red-500",
    info: "bg-sky-50 text-sky-600",
    neutral: "bg-slate-100 text-slate-500",
  };
  return (
    <Card className="h-full min-w-0 overflow-hidden transition-shadow hover:shadow-md">
      <CardContent className="flex h-full min-w-0 flex-col p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[13px] font-medium text-slate-500">{label}</p>
          {icon ? (
            <span aria-hidden="true" className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", tones[tone])}>
              {icon}
            </span>
          ) : null}
        </div>
        <p title={value} className="mt-1 truncate text-2xl leading-8 font-bold tracking-tight text-slate-900 tabular-nums sm:text-3xl sm:leading-9">{value}</p>
        <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1.5">
          {trend ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
                trend.direction === "up" && "bg-emerald-50 text-emerald-700",
                trend.direction === "down" && "bg-red-50 text-red-600",
                trend.direction === "flat" && "bg-slate-100 text-slate-500"
              )}
            >
              <span aria-hidden="true">
                {trend.direction === "up" ? "▲" : trend.direction === "down" ? "▼" : "●"}
              </span>
              {trend.text}
            </span>
          ) : null}
          <p className="text-xs text-slate-400">{hint}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export const StatIcons = {
  total: (
    <svg className="size-4" viewBox="0 0 16 16" fill="none"><path d="M8 14a6 6 0 100-12 6 6 0 000 12zM5.5 8h5M8 5.5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
  ),
  fresh: (
    <svg className="size-4" viewBox="0 0 16 16" fill="none"><path d="M8 1.5l1.8 3.8 4.2.5-3 2.9.7 4.1L8 10.8l-3.7 2 .7-4.1-3-2.9 4.2-.5L8 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
  ),
  contacted: (
    <svg className="size-4" viewBox="0 0 16 16" fill="none"><path d="M2.5 3.5h11v7h-6l-2.5 2v-2H2.5v-7z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
  ),
  interested: (
    <svg className="size-4" viewBox="0 0 16 16" fill="none"><path d="M8 14s5-3.1 5-7A5 5 0 003 7c0 3.9 5 7 5 7z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
  ),
  followUp: (
    <svg className="size-4" viewBox="0 0 16 16" fill="none"><path d="M8 4v4l2.5 1.5M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
  ),
  converted: (
    <svg className="size-4" viewBox="0 0 16 16" fill="none"><path d="M2.5 8.5l3.5 3.5 7-8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
  ),
  lost: (
    <svg className="size-4" viewBox="0 0 16 16" fill="none"><path d="M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM6 6l4 4M10 6l-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
  ),
  rate: (
    <svg className="size-4" viewBox="0 0 16 16" fill="none"><path d="M2 13.5h12M4.5 13.5V9M8 13.5V5.5M11.5 13.5V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
  ),
};
