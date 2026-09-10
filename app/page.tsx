import { Badge } from "@/src/components/ui/badge";
import { ButtonLink } from "@/src/components/ui/button";
import { Card, CardContent } from "@/src/components/ui/card";
import { BrandMark } from "@/src/components/layout/auth-layout";

const FEATURES = [
  {
    title: "Facebook Lead Ads sync",
    description: "New prospects flow into your pipeline the moment they submit a form — no spreadsheets, no copy-paste.",
  },
  {
    title: "WhatsApp follow-up",
    description: "Reply from one shared inbox with approved templates and full conversation history per lead.",
  },
  {
    title: "Assignment & reminders",
    description: "Route leads to the right agent automatically and never miss a follow-up with smart reminders.",
  },
  {
    title: "Conversion dashboard",
    description: "See which campaigns turn into admissions and sales, from first click to closed deal.",
  },
];

const STEPS = [
  ["Connect Facebook", "Link your Page and lead forms in minutes with guided setup."],
  ["Assign & follow up", "Leads route to your agents; WhatsApp outreach goes out on time."],
  ["Convert & measure", "Track every lead to enrollment and double down on what works."],
];

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="border-b border-slate-100">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <BrandMark />
          <nav aria-label="Primary" className="flex items-center gap-2">
            <ButtonLink href="/login" variant="ghost" size="sm">
              Log in
            </ButtonLink>
            <ButtonLink href="/register" size="sm">
              Start free
            </ButtonLink>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto w-full max-w-6xl px-4 pt-14 pb-10 text-center sm:px-6 sm:pt-20">
          <Badge variant="brand" dot>
            Built for Bangladesh businesses
          </Badge>
          <h1 className="mx-auto mt-5 max-w-3xl text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
            Turn Facebook leads into <span className="text-brand-700">enrollments & sales</span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base text-slate-500 sm:text-lg">
            LeadFlow captures every Facebook lead, assigns it to the right agent, and keeps
            WhatsApp follow-up consistent — so coaching centers, consultancies, and real-estate
            teams stop losing customers to slow replies.
          </p>
          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href="/register" size="lg">
              Start free trial
            </ButtonLink>
            <ButtonLink href="/login" variant="outline" size="lg">
              Log in
            </ButtonLink>
          </div>
          <p className="mt-4 text-xs text-slate-400">Free 14-day trial · No credit card required · Bangla support</p>
        </section>

        {/* Stats */}
        <section aria-label="Results" className="border-y border-slate-100 bg-slate-50">
          <dl className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 px-4 py-8 sm:grid-cols-3 sm:px-6">
            {[
              ["38%", "more follow-ups completed on time"],
              ["2.4×", "faster first response to new leads"],
              ["12k+", "leads managed by early customers"],
            ].map(([stat, label]) => (
              <div key={label} className="text-center">
                <dd className="text-3xl font-bold text-slate-900">{stat}</dd>
                <dt className="mt-1 text-sm text-slate-500">{label}</dt>
              </div>
            ))}
          </dl>
        </section>

        {/* Features */}
        <section aria-labelledby="features-heading" className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
          <h2 id="features-heading" className="text-center text-2xl font-bold text-slate-900 sm:text-3xl">
            Everything between click and customer
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-center text-sm text-slate-500 sm:text-base">
            One workspace for your whole sales team — from first form fill to final payment.
          </p>
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <Card key={f.title}>
                <CardContent>
                  <h3 className="text-base font-semibold text-slate-900">{f.title}</h3>
                  <p className="mt-1 text-sm text-slate-500">{f.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section aria-labelledby="how-heading" className="border-t border-slate-100 bg-slate-50">
          <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="how-heading" className="text-center text-2xl font-bold text-slate-900 sm:text-3xl">
              Live in three steps
            </h2>
            <ol className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
              {STEPS.map(([title, body], i) => (
                <li key={title} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <p aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-800">
                    {i + 1}
                  </p>
                  <h3 className="mt-3 text-base font-semibold text-slate-900">{title}</h3>
                  <p className="mt-1 text-sm text-slate-500">{body}</p>
                </li>
              ))}
            </ol>
            <div className="mt-8 text-center">
              <ButtonLink href="/register" size="lg">
                Get started today
              </ButtonLink>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-100">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-4 py-6 text-xs text-slate-400 sm:flex-row sm:px-6">
          <p>© {new Date().getFullYear()} LeadFlow BD. All rights reserved.</p>
          <nav aria-label="Footer" className="flex gap-4">
            <a href="/login" className="transition-colors hover:text-slate-600">Log in</a>
            <a href="/register" className="transition-colors hover:text-slate-600">Sign up</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
