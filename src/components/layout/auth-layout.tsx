import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

/** Marketing/auth brand header shared by public pages. */
export function BrandMark({ compact }: { compact?: boolean }) {
  return (
    <Link href="/" className="inline-flex items-center gap-2.5" aria-label="LeadFlow BD home">
      <Image src="/icon.png" alt="" aria-hidden="true" width={36} height={36} className="size-9 rounded-lg" />
      {!compact ? (
        <span className="flex flex-col leading-none">
          <span className="text-[15px] font-bold text-slate-900">LeadFlow</span>
          <span className="text-[11px] font-semibold tracking-widest text-brand-700 uppercase">Bangladesh</span>
        </span>
      ) : null}
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
      <div className="hidden w-1/2 flex-col justify-between bg-slate-900 p-10 text-white lg:flex">
        <BrandMark />
        <div className="max-w-md">
          <blockquote className="text-2xl leading-snug font-semibold">
            “We stopped losing Facebook leads the week we switched to LeadFlow.”
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
        <p className="text-xs text-slate-400">© {new Date().getFullYear()} LeadFlow BD</p>
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
