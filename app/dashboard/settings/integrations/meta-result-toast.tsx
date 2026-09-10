"use client";

import { useEffect } from "react";
import { useToast } from "@/src/components/ui/toast";

/** Surfaces the Meta OAuth callback outcome (?meta=connected|error) once. */
export function MetaResultToast({ flag }: { flag: string | null }) {
  const toast = useToast();
  useEffect(() => {
    if (flag === "connected") {
      toast({ title: "Facebook connected", description: "Lead import is ready to configure.", variant: "success" });
    } else if (flag === "error") {
      toast({ title: "Facebook connection failed", description: "Please try again.", variant: "error" });
    }
  }, [flag, toast]);
  return null;
}
