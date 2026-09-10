"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/src/lib/cn";

type ToastVariant = "success" | "error" | "info";

interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
}

interface ToastItem extends ToastInput {
  id: number;
  variant: ToastVariant;
}

const ToastContext = createContext<(input: ToastInput) => void>(() => {});

export function useToast(): (input: ToastInput) => void {
  return useContext(ToastContext);
}

const VARIANTS: Record<ToastVariant, { bar: string; icon: ReactNode }> = {
  success: {
    bar: "bg-emerald-500",
    icon: (
      <svg aria-hidden="true" className="size-5 text-emerald-600" viewBox="0 0 20 20" fill="none">
        <path d="M10 1.7a8.3 8.3 0 100 16.6 8.3 8.3 0 000-16.6zm3.7 6.2l-4.5 4.5a.8.8 0 01-1.1 0L6.3 10.6a.8.8 0 011.1-1.1l1.2 1.2 4-4a.8.8 0 011.1 1.2z" fill="currentColor" />
      </svg>
    ),
  },
  error: {
    bar: "bg-red-500",
    icon: (
      <svg aria-hidden="true" className="size-5 text-red-600" viewBox="0 0 20 20" fill="none">
        <path d="M10 1.7a8.3 8.3 0 100 16.6 8.3 8.3 0 000-16.6zM9 6.5a1 1 0 012 0v4a1 1 0 01-2 0v-4zm0 6a1 1 0 110 2 1 1 0 010-2z" fill="currentColor" />
      </svg>
    ),
  },
  info: {
    bar: "bg-sky-500",
    icon: (
      <svg aria-hidden="true" className="size-5 text-sky-600" viewBox="0 0 20 20" fill="none">
        <path d="M10 1.7a8.3 8.3 0 100 16.6 8.3 8.3 0 000-16.6zM9 8.5a1 1 0 012 0v4a1 1 0 01-2 0v-4zM10 6a1.1 1.1 0 100-2.2A1.1 1.1 0 0010 6z" fill="currentColor" />
      </svg>
    ),
  },
};

/** Provides `useToast()` and renders the notification viewport (aria-live). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev.slice(-3), { ...input, id, variant: input.variant ?? "info" }]);
      window.setTimeout(() => dismiss(id), 4500);
    },
    [dismiss]
  );

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[70] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-96"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.variant === "error" ? "alert" : "status"}
            className="pointer-events-auto flex items-start gap-3 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg"
          >
            <span aria-hidden="true" className={cn("w-1 self-stretch", VARIANTS[t.variant].bar)} />
            <span className="py-1" aria-hidden="true">
              {VARIANTS[t.variant].icon}
            </span>
            <div className="min-w-0 flex-1 py-3 pr-1">
              <p className="text-sm font-semibold text-slate-900">{t.title}</p>
              {t.description ? <p className="mt-0.5 text-sm text-slate-500">{t.description}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="cursor-pointer rounded-md p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            >
              <svg aria-hidden="true" className="size-4" viewBox="0 0 16 16" fill="none">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
