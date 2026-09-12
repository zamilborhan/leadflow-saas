"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Dropdown } from "@/src/components/ui/dropdown";

interface BellItem {
  id: string;
  title: string;
  leadId: string | null;
}

const POLL_MS = 60_000;
const MAX_LABEL = 42;
const INITIAL_DELAY_MS = 2500;

function truncate(s: string): string {
  return s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s;
}

/**
 * Live notification bell: unread badge, recent unread preview, mark-read
 * on open, mark-all action. Polls the badge endpoint; silent on errors so
 * a notification outage never breaks the header.
 */
export function NotificationBell({ businessId }: { businessId: string | null }) {
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<BellItem[]>([]);

  const refresh = useCallback(async () => {
    if (!businessId) return null;
    try {
      const [countRes, listRes] = await Promise.all([
        fetch(`/api/businesses/${businessId}/notifications/unread-count`, { cache: "no-store" }),
        fetch(`/api/businesses/${businessId}/notifications?unreadOnly=1&limit=8`, { cache: "no-store" }),
      ]);
      const next: { unread?: number; items?: BellItem[] } = {};
      if (countRes.ok) {
        const data = (await countRes.json()) as { unread?: number };
        if (typeof data.unread === "number") next.unread = data.unread;
      }
      if (listRes.ok) {
        const data = (await listRes.json()) as { notifications?: BellItem[] };
        if (Array.isArray(data.notifications)) next.items = data.notifications;
      }
      return next;
    } catch {
      // Badge stays stale rather than breaking navigation.
      return null;
    }
  }, [businessId]);

  // Deferred initial load + visibility-aware polling: the bell never
  // blocks header paint (first fetch fires after idle), polls at 60s only
  // while the tab is visible, and skips overlapping requests.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const apply = (next: { unread?: number; items?: BellItem[] } | null) => {
      if (cancelled || !next) return;
      if (next.unread !== undefined) setUnread(next.unread);
      if (next.items !== undefined) setItems(next.items);
    };
    const tick = () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      refresh().then((n) => {
        inFlight = false;
        apply(n);
      });
    };
    const idle = window.setTimeout(tick, INITIAL_DELAY_MS);
    const timer = setInterval(tick, POLL_MS);
    const onFocus = () => tick();
    const onVisibility = () => tick();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(idle);
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  async function markAll() {
    if (!businessId) return;
    try {
      await fetch(`/api/businesses/${businessId}/notifications/read-all`, { method: "POST" });
    } catch {
      // Optimistic anyway.
    }
    setUnread(0);
    setItems([]);
    router.refresh();
  }

  function openItem(item: BellItem) {
    if (!businessId) return;
    fetch(`/api/businesses/${businessId}/notifications/${item.id}/read`, { method: "POST" }).catch(() => {});
    setUnread((u) => Math.max(0, u - 1));
    setItems((prev) => prev.filter((n) => n.id !== item.id));
    router.push(
      item.leadId
        ? `/dashboard/leads/${item.leadId}?businessId=${businessId}`
        : `/dashboard/notifications?businessId=${businessId}`
    );
    router.refresh();
  }

  if (!businessId) return null;

  const badge = unread > 0 ? unread > 9 ? "9+" : String(unread) : null;

  return (
    <Dropdown
      label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      align="right"
      trigger={
        <span className="relative block p-1" aria-hidden="true">
          <svg aria-hidden="true" className="size-5" viewBox="0 0 20 20" fill="none">
            <path d="M10 2.5a4.5 4.5 0 00-4.5 4.5c0 4-1.5 5-1.5 5h12s-1.5-1-1.5-5A4.5 4.5 0 0010 2.5zM8.5 15a1.5 1.5 0 003 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {badge ? (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-bold text-white ring-2 ring-white">
              {badge}
            </span>
          ) : null}
        </span>
      }
      items={[
        ...(items.length === 0
          ? [{ label: "No new notifications", onSelect: () => {} }]
          : items.map((item) => ({ label: truncate(item.title), onSelect: () => openItem(item) }))),
        ...(unread > 0 ? [{ label: "Mark all as read", onSelect: markAll }] : []),
        { label: "View all notifications", href: `/dashboard/notifications?businessId=${businessId}` },
      ]}
    />
  );
}
