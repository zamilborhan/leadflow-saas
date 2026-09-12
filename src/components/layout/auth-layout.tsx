import Link from "next/link";
import type { ReactNode } from "react";
import { LeadFlowLogo } from "@/src/components/brand/LeadFlowLogo";

/** Marketing/auth brand header shared by public pages. */
export function BrandMark({ compact }: { compact?: boolean }) {
  return (
    <Link href="/" className="inline-flex items-center rounded-lg" aria-label="LeadFlow home">
      {compact ? <LeadFlowLogo variant="mark" /> : <LeadFlowLogo />}
    </Link>
  );
}

/**
 * Auth layout: centered card over a two-panel split (brand story on lg+).
 * `children` is the form card content; `title`/`subtitle` head the card.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-slate-100">
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-slate-950 p-10 text-white lg:flex">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="absolute -top-24 -left-24 size-96 rounded-full bg-brand-600/25 blur-3xl" />
          <div className="absolute right-0 bottom-0 size-80 rounded-full bg-brand-500/15 blur-3xl" />
          <svg className="absolute inset-0 h-full w-full opacity-[0.07]" aria-hidden="true">
            <defs>
              <pattern id="lf-grid" width="32" height="32" patternUnits="userSpaceOnUse">
                <path d="M32 0H0v32" fill="none" stroke="white" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#lf-grid)" />
          </svg>
        </div>
        <div className="relative">
          <span className="[&_span]:!text-white [&_span:last-child]:!text-brand-300">
            <LeadFlowLogo />
          </span>
        </div>
        <div className="relative max-w-md">
          <div className="flex items-center gap-2">
            {["Capture", "Assign", "Follow up", "Convert"].map((s, i) => (
              <span key={s} className="flex items-center gap-2 text-xs font-medium text-slate-300">
                {i > 0 ? <span aria-hidden="true" className="text-brand-400">→</span> : null}
                {s}
              </span>
            ))}
          </div>
          <blockquote className="mt-4 text-2xl leading-snug font-semibold tracking-tight">
            “We stopped losing leads the week we switched to LeadFlow.”
          </blockquote>
          <p className="mt-4 text-sm text-slate-300">
            Rahim Uddin — Owner, Uddin Coaching Center, Dhaka
          </p>
          <dl className="mt-8 grid grid-cols-3 gap-6 border-t border-white/10 pt-6">
            {[
              ["38%", "more follow-ups"],
              ["2.4×", "faster response"],
              ["12k+", "leads managed"],
            ].map(([stat, label]) => (
              <div key={label}>
                <dt className="sr-only">{label}</dt>
                <dd className="text-2xl font-bold text-brand-300">{stat}</dd>
                <dd className="mt-1 text-xs text-slate-300">{label}</dd>
              </div>
            ))}
          </dl>
        </div>
        <p className="relative text-xs text-slate-400">© {new Date().getFullYear()} LeadFlow · Trusted lead CRM</p>
      </div>
      <main className="flex flex-1 flex-col px-4 py-8 sm:px-8">
        <div className="lg:hidden">
          <BrandMark />
        </div>
        <div className="flex flex-1 items-center justify-center py-8">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
            <div className="mt-6">{children}</div>
            {footer ? <div className="mt-6 border-t border-slate-100 pt-5 text-center text-sm text-slate-500">{footer}</div> : null}
          </div>
        </div>
      </main>
    </div>
  );
}
