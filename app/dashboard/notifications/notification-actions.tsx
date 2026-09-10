"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/src/components/ui/button";
import { useToast } from "@/src/components/ui/toast";

/** Mark a single notification as read, then refresh the list + badge. */
export function MarkReadButton({ businessId, notificationId }: { businessId: string; notificationId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/notifications/${notificationId}/read`, {
        method: "POST",
      });
      if (!res.ok) {
        toast({ title: "Could not mark as read", description: "Please try again.", variant: "error" });
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onClick}>
      {pending ? "Saving…" : "Mark as read"}
    </Button>
  );
}

/** Mark every unread notification as read, then refresh. */
export function MarkAllReadButton({ businessId, disabled }: { businessId: string; disabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/notifications/read-all`, { method: "POST" });
      if (!res.ok) {
        toast({ title: "Could not mark all as read", description: "Please try again.", variant: "error" });
        return;
      }
      const data = (await res.json()) as { marked?: number };
      toast({
        title: "All caught up",
        description: `${data.marked ?? 0} notification${(data.marked ?? 0) === 1 ? "" : "s"} marked as read.`,
        variant: "success",
      });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <Button type="button" variant="outline" disabled={disabled || pending} onClick={onClick}>
      {pending ? "Saving…" : "Mark all as read"}
    </Button>
  );
}

/** Regenerate derived notifications (due/overdue follow-ups, connection expiry). */
export function SyncNotificationsButton({ businessId }: { businessId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/notifications/sync`, { method: "POST" });
      if (!res.ok) {
        toast({ title: "Sync failed", description: "Please try again.", variant: "error" });
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <Button type="button" variant="outline" disabled={pending} onClick={onClick}>
      {pending ? "Syncing…" : "Refresh"}
    </Button>
  );
}
