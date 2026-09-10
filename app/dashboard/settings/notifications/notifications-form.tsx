"use client";

import { Button } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Field } from "@/src/components/ui/input";
import { Select } from "@/src/components/ui/select";
import { useToast } from "@/src/components/ui/toast";

/** Notification preferences (preview): channel + cadence controls. */
export function NotificationForm() {
  const toast = useToast();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    toast({ title: "Preview only", description: "Preferences save with the settings integration.", variant: "info" });
  }

  return (
    <form onSubmit={onSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <CardDescription>Choose how your team hears about new leads and follow-ups.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field label="New lead alerts" hint="Sent instantly when a prospect arrives.">
            <Select defaultValue="whatsapp">
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
              <option value="both">WhatsApp + Email</option>
              <option value="none">Off</option>
            </Select>
          </Field>
          <Field label="Follow-up reminders" hint="Nudge assignees before reminders go overdue.">
            <Select defaultValue="daily">
              <option value="instant">Instant</option>
              <option value="daily">Daily digest</option>
              <option value="none">Off</option>
            </Select>
          </Field>
          <Field label="Weekly summary" hint="Performance recap every Monday morning.">
            <Select defaultValue="email">
              <option value="email">Email</option>
              <option value="none">Off</option>
            </Select>
          </Field>
        </CardContent>
        <CardFooter>
          <Button type="submit">Save preferences</Button>
        </CardFooter>
      </Card>
    </form>
  );
}
