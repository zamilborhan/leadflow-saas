import { Badge } from "@/src/components/ui/badge";
import { EmptyState } from "@/src/components/ui/states";
import { ACTIVITY_BADGE, ACTIVITY_LABEL } from "../lead-status";

export interface TimelineEntry {
  id: string;
  type: string;
  body: string | null;
  actorName: string;
  createdAt: string;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Append-only activity timeline, newest first. Every entry shows what
 * happened, detail text, who performed it, and when.
 */
export function ActivityTimeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return (
      <EmptyState
        title="No activity yet"
        description="Lead creation, assignment, status changes, notes, follow-ups, and WhatsApp messages will appear here."
      />
    );
  }
  return (
    <ol className="flex flex-col">
      {entries.map((entry, i) => (
        <li key={entry.id} className="relative flex gap-4 pb-6 last:pb-0">
          {i < entries.length - 1 ? (
            <span aria-hidden="true" className="absolute top-7 left-[13px] h-[calc(100%-1.75rem)] w-px bg-slate-200" />
          ) : null}
          <span aria-hidden="true" className="mt-1 size-[27px] shrink-0 rounded-full border-2 border-brand-200 bg-brand-50" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={ACTIVITY_BADGE[entry.type] ?? "neutral"}>
                {ACTIVITY_LABEL[entry.type] ?? entry.type}
              </Badge>
              <span className="text-xs text-slate-400">
                <time dateTime={entry.createdAt}>{formatTimestamp(entry.createdAt)}</time>
              </span>
            </div>
            {entry.body ? <p className="mt-1 text-sm text-slate-700">{entry.body}</p> : null}
            <p className="mt-1 text-xs text-slate-500">by {entry.actorName}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
