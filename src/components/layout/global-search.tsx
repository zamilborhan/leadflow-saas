"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface SearchHit {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
}

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className ?? "size-4"} viewBox="0 0 16 16" fill="none">
      <circle cx="7.5" cy="7.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M11 11l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Simple inline header search: compact input + dropdown of matching leads.
 * - 300ms debounce, stale requests cancelled, ≥2 chars, max 8 results.
 * - Enter opens the highlighted lead, Esc closes, click-outside closes.
 */
export function GlobalSearch({ businessId }: { businessId: string | null }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mobileInputRef = useRef<HTMLInputElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setMobileOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  useEffect(() => {
    if (mobileOpen) mobileInputRef.current?.focus();
  }, [mobileOpen]);

  // Debounced, abortable fetch — only after MIN_CHARS.
  useEffect(() => {
    const q = query.trim();
    if (!businessId || q.length < MIN_CHARS) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    timerRef.current = setTimeout(async () => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const res = await fetch(
          `/api/businesses/${businessId}/search?q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal, cache: "no-store" }
        );
        if (!res.ok) throw new Error("search failed");
        const data = (await res.json()) as { results?: SearchHit[] };
        if (!ctrl.signal.aborted) {
          setHits(Array.isArray(data.results) ? data.results.slice(0, 8) : []);
          setActive(0);
          setOpen(true);
        }
      } catch {
        if (!ctrl.signal.aborted) {
          setHits([]);
          setOpen(true);
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, businessId]);

  function onQueryChange(value: string) {
    setQuery(value);
    if (value.trim().length < MIN_CHARS) {
      abortRef.current?.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
      setHits([]);
      setLoading(false);
      setOpen(false);
    }
  }

  function go(hit: SearchHit) {
    setOpen(false);
    setMobileOpen(false);
    setQuery("");
    setHits([]);
    router.push(`/dashboard/leads/${hit.id}?businessId=${businessId}`);
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" && hits.length > 0) {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === "ArrowUp" && hits.length > 0) {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && hits.length > 0) {
      e.preventDefault();
      const hit = hits[active] ?? hits[0];
      if (hit) go(hit);
    } else if (e.key === "Escape") {
      setOpen(false);
      setMobileOpen(false);
    }
  }

  function contactLine(h: SearchHit): string | null {
    if (h.phone && h.email) return `${h.phone} · ${h.email}`;
    return h.phone ?? h.email;
  }

  function resultsContent({ highlight }: { highlight: boolean }) {
    if (loading) {
      return (
        <p role="status" className="flex items-center justify-center gap-2 px-3 py-4 text-xs text-slate-400">
          <span aria-hidden="true" className="size-3.5 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600" />
          Searching…
        </p>
      );
    }
    if (hits.length === 0) {
      return <p className="px-3 py-4 text-center text-xs text-slate-400">No results found</p>;
    }
    return (
      <ul role="listbox" aria-label="Matching leads" className="max-h-72 overflow-y-auto p-1.5">
        {hits.map((h, i) => {
          const contact = contactLine(h);
          return (
            <li key={h.id} role="option" aria-selected={highlight && i === active}>
              <button
                type="button"
                onClick={() => go(h)}
                onMouseEnter={highlight ? () => setActive(i) : undefined}
                className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${highlight && i === active ? "bg-brand-50" : "hover:bg-slate-50"}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-900">{h.name}</span>
                  {contact ? (
                    <span className="block truncate text-xs text-slate-400">{contact}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  function dropdown() {
    if (!open || query.trim().length < MIN_CHARS) return null;
    return (
      <div className="absolute top-full right-0 left-0 z-50 mt-1.5 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
        {resultsContent({ highlight: true })}
      </div>
    );
  }

  if (!businessId) return null;

  return (
    <div ref={boxRef} className="relative">
      {/* Desktop: compact inline input */}
      <div className="relative hidden sm:block">
        <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400">
          <SearchIcon />
        </span>
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onInputKey}
          onFocus={() => {
            if (hits.length > 0 && query.trim().length >= MIN_CHARS) setOpen(true);
          }}
          type="search"
          placeholder="Search leads..."
          aria-label="Search leads"
          autoComplete="off"
          className="h-9 w-44 rounded-lg border border-slate-200 bg-slate-50 pr-8 pl-8 text-sm text-slate-900 transition-all outline-none placeholder:text-slate-400 hover:border-slate-300 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100 lg:w-56"
        />
        {loading ? (
          <span
            role="status"
            aria-label="Searching"
            className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600"
          />
        ) : null}
        {dropdown()}
      </div>

      {/* Mobile: icon toggles a compact dropdown panel with input */}
      <div className="sm:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label="Search leads"
          aria-expanded={mobileOpen}
          className="cursor-pointer rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
        >
          <SearchIcon className="size-5" />
        </button>
        {mobileOpen ? (
          <div className="absolute top-full right-0 z-50 mt-1.5 w-64 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
            <div className="relative border-b border-slate-100">
              <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400">
                <SearchIcon />
              </span>
              <input
                ref={mobileInputRef}
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                onKeyDown={onInputKey}
                type="search"
                placeholder="Search leads..."
                aria-label="Search leads"
                autoComplete="off"
                className="h-10 w-full bg-transparent pr-8 pl-8 text-sm text-slate-900 outline-none placeholder:text-slate-400"
              />
              {loading ? (
                <span
                  role="status"
                  aria-label="Searching"
                  className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600"
                />
              ) : null}
            </div>
            {query.trim().length >= MIN_CHARS ? resultsContent({ highlight: false }) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
