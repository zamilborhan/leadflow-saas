"use client";

import { useState } from "react";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Field, Input } from "@/src/components/ui/input";
import { Select } from "@/src/components/ui/select";
import { useToast } from "@/src/components/ui/toast";

/** Workspace profile form (preview): validation + toast wiring are live, persistence follows. */
export function GeneralSettingsForm() {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const toast = useToast();

  const error = name.trim().length === 0 ? "Business name is required." : null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (error) return;
    toast({ title: "Preview only", description: "Workspace saving connects with the settings integration.", variant: "info" });
  }

  return (
    <form onSubmit={onSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>Business profile</CardTitle>
          <CardDescription>How your workspace appears to your team.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field label="Business name" required error={touched ? error : null}>
            <Input
              type="text"
              autoComplete="organization"
              placeholder="e.g. Uddin Coaching Center"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Industry">
              <Select defaultValue="">
                <option value="">Select industry…</option>
                <option>Coaching center</option>
                <option>IELTS center</option>
                <option>Education consultancy</option>
                <option>Real estate</option>
                <option>Visa consultancy</option>
                <option>Other</option>
              </Select>
            </Field>
            <Field label="Timezone">
              <Select defaultValue="Asia/Dhaka">
                <option value="Asia/Dhaka">Asia/Dhaka (GMT+6)</option>
                <option value="UTC">UTC</option>
              </Select>
            </Field>
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit">Save changes</Button>
        </CardFooter>
      </Card>
    </form>
  );
}
