"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/src/lib/cn";

export interface DropdownItem {
  label: string;
  href?: string;
  onSelect?: () => void;
  danger?: boolean;
}

interface DropdownProps {
  label: string;
  trigger: ReactNode;
  items: DropdownItem[];
  align?: "left" | "right";
}

/**
 * Accessible menu: Escape closes, ArrowUp/Down move, Enter/Space activate.
 * Closes on outside click. Trigger keeps focus ownership.
 */
export function Dropdown({ label, trigger, items, align = "right" }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | HTMLButtonElement | null>>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open ]);

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  function onTriggerKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setActive(0);
      setOpen(true);
    }
  }

  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    }
  }

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKey}
        className="cursor-pointer rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
      >
        {trigger}
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          className={cn(
            "absolute z-50 mt-1 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg",
            align === "right" ? "right-0" : "left-0"
          )}
        >
          {items.map((item, i) => {
            const classes = cn(
              "flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50 focus:bg-slate-50 focus:outline-none",
              item.danger ? "text-red-600" : "text-slate-700"
            );
            const ref = (el: HTMLAnchorElement | HTMLButtonElement | null) => {
              itemRefs.current[i] = el;
            };
            const onActivate = () => {
              setOpen(false);
              item.onSelect?.();
            };
            return item.href ? (
              <a
                key={item.label}
                ref={ref as (el: HTMLAnchorElement | null) => void}
                href={item.href}
                role="menuitem"
                tabIndex={-1}
                onClick={() => setOpen(false)}
                className={classes}
              >
                {item.label}
              </a>
            ) : (
              <button
                key={item.label}
                ref={ref as (el: HTMLButtonElement | null) => void}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={onActivate}
                className={classes}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
