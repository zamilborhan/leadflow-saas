"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { Select } from "@/src/components/ui/select";

export interface AnalyticsFilters {
  days: string;
  from: string;
  to: string;
  campaign: string;
  adSet: string;
  ad: string;
}

/** Toolbar driving the analytics URL: date presets/range + funnel filters. */
export function AnalyticsFilterBar({
  businessId,
  initial,
}: {
  businessId: string;
  initial: AnalyticsFilters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [campaign, setCampaign] = useState(initial.campaign);
  const [adSet, setAdSet] = useState(initial.adSet);
  const [ad, setAd] = useState(initial.ad);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);

  function navigate(overrides: Partial<AnalyticsFilters>) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("businessId", businessId);
    const next = { ...initial, campaign, adSet, ad, from, to, ...overrides };
    // Applying with hand-entered dates switches the preset to custom.
    const ranged = next.from !== "" || next.to !== "";
    params.set("days", Object.keys(overrides).length === 0 && ranged ? "custom" : next.days);
    params.set("from", next.from);
    params.set("to", next.to);
    params.set("campaign", next.campaign);
    params.set("adSet", next.adSet);
    params.set("ad", next.ad);
    router.replace(`${pathname}?${params.toString()}`);
  }

  function clear() {
    const params = new URLSearchParams();
    params.set("businessId", businessId);
    params.set("days", "30");
    router.replace(`${pathname}?${params.toString()}`);
  }

  return (
    <form
      className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 sm:px-6 lg:flex-row lg:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        navigate({});
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="analytics-days" className="text-xs font-medium text-slate-500">
          Date range
        </label>
        <Select
          id="analytics-days"
          value={initial.days}
          onChange={(e) => navigate({ days: e.target.value, from: "", to: "" })}
          className="sm:w-40"
        >
          <option value="7">Last 7 days</option>
          <option value="14">Last 14 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="custom">Custom range</option>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="analytics-from" className="text-xs font-medium text-slate-500">
          From
        </label>
        <Input
          id="analytics-from"
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
          className="sm:w-44"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="analytics-to" className="text-xs font-medium text-slate-500">
          To
        </label>
        <Input
          id="analytics-to"
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
          className="sm:w-44"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="analytics-campaign" className="text-xs font-medium text-slate-500">
          Campaign
        </label>
        <Input
          id="analytics-campaign"
          type="search"
          placeholder="Filter by campaign…"
          value={campaign}
          onChange={(e) => setCampaign(e.target.value)}
          className="lg:max-w-52"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="analytics-adset" className="text-xs font-medium text-slate-500">
          Ad set
        </label>
        <Input
          id="analytics-adset"
          type="search"
          placeholder="Filter by ad set…"
          value={adSet}
          onChange={(e) => setAdSet(e.target.value)}
          className="lg:max-w-52"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="analytics-ad" className="text-xs font-medium text-slate-500">
          Ad
        </label>
        <Input
          id="analytics-ad"
          type="search"
          placeholder="Filter by ad…"
          value={ad}
          onChange={(e) => setAd(e.target.value)}
          className="lg:max-w-52"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="outline">
          Apply
        </Button>
        <Button type="button" variant="ghost" onClick={clear}>
          Reset
        </Button>
      </div>
    </form>
  );
}
