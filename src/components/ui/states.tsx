import type { ReactNode } from "react";
import { cn } from "@/src/lib/cn";
import { Button } from "./button";

function StateShell({
  icon,
  title,
  description,
  action,
  tone,
  role,
  className,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  tone: string;
  role?: string;
  className?: string;
}) {
  return (
    <div
      role={role}
      className={cn("flex flex-col items-center px-6 py-12 text-center sm:py-16", className)}
    >
      <span aria-hidden="true" className={cn("flex size-12 items-center justify-center rounded-full", tone)}>
        {icon}
      </span>
      <h3 className="mt-4 text-base font-semibold text-slate-900">{title}</h3>
      {description ? <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

const ICON = "size-6";

/** Empty collection placeholder with an optional call to action. */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <StateShell
      tone="bg-slate-100 text-slate-400"
      title={title}
      description={description}
      action={action}
      className={className}
      icon={
        <svg className={ICON} viewBox="0 0 24 24" fill="none">
          <path
            d="M20 7H4a1 1 0 00-1 1v9a2 2 0 002 2h14a2 2 0 002-2V8a1 1 0 00-1-1zM8 7V5a2 2 0 012-2h4a2 2 0 012 2v2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      }
    />
  );
}

/** Loading placeholder. `label` is announced via role=status. */
export function LoadingState({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn("flex flex-col items-center px-6 py-12 text-center sm:py-16", className)}>
      <span aria-hidden="true" className="size-8 animate-spin rounded-full border-[3px] border-slate-200 border-t-brand-600" />
      <p className="mt-4 text-sm font-medium text-slate-500">{label}</p>
    </div>
  );
}

/** Skeleton lines for loading content shapes. Decorative (aria-hidden). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-slate-200", className)} />;
}

/** Failure placeholder with retry. Announced via role=alert. */
export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  retryLabel = "Try again",
  className,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <StateShell
      role="alert"
      tone="bg-red-50 text-red-500"
      title={title}
      description={message}
      className={className}
      action={
        onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : undefined
      }
      icon={
        <svg className={ICON} viewBox="0 0 24 24" fill="none">
          <path
            d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      }
    />
  );
}
