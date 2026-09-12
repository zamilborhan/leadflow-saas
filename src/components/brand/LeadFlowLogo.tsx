import Link from "next/link";
import { cn } from "@/src/lib/cn";

function FlowMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[10px] bg-brand-600 text-white shadow-sm",
        className ?? "size-9"
      )}
    >
      <svg viewBox="0 0 24 24" fill="none" className="size-[60%]">
        <path
          d="M4 7c3.5 0 3.5 3 7 3s3.5-3 7-3M4 12c3.5 0 3.5 3 7 3s3.5-3 7-3M4 17c3.5 0 3.5 3 7 3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="18.5" cy="19.5" r="1.6" fill="currentColor" />
      </svg>
    </span>
  );
}

/**
 * Reusable LeadFlow brand lockup — sidebar, auth, navbar, mobile, marketing.
 * Single source of truth so logo + favicon-adjacent mark stay in one system.
 */
export function LeadFlowLogo({
  variant = "full",
  className,
}: {
  variant?: "full" | "mark";
  className?: string;
}) {
  if (variant === "mark") return <FlowMark className={className} />;
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <FlowMark />
      <span className="flex flex-col leading-none">
        <span className="text-[15px] font-bold tracking-tight text-slate-900">LeadFlow</span>
        <span className="mt-0.5 text-[10px] font-semibold tracking-[0.14em] text-brand-600 uppercase">
          Lead CRM
        </span>
      </span>
    </span>
  );
}

export function LeadFlowLogoLink({ href }: { href: string }) {
  return (
    <Link href={href} aria-label="LeadFlow home" className="inline-flex rounded-lg">
      <LeadFlowLogo />
    </Link>
  );
}
