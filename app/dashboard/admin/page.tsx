"use client";

import { useState } from "react";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { ConfirmDialog } from "@/src/components/ui/confirm-dialog";
import { Input } from "@/src/components/ui/input";
import { PageHeader } from "@/src/components/ui/page-header";
import { useToast } from "@/src/components/ui/toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { EmptyState } from "@/src/components/ui/states";

/**
 * Platform admin panel (preview shell): platform metrics, workspace
 * directory, and a guarded destructive action demonstrating ConfirmDialog.
 */
export default function AdminPage() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const toast = useToast();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Admin"
        description="Platform overview and workspace management. Restricted to platform staff."
        eyebrow="Administration"
      />

      <section aria-label="Platform metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          ["Workspaces", "—", "Businesses on the platform"],
          ["Users", "—", "Across all workspaces"],
          ["Leads (30d)", "—", "Captured in the last month"],
        ].map(([label, value, hint]) => (
          <Card key={label}>
            <CardContent>
              <p className="text-sm font-medium text-slate-500">{label}</p>
              <p className="mt-1 text-3xl font-bold text-slate-900">{value}</p>
              <p className="mt-1 text-xs text-slate-400">{hint}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>Search and manage customer workspaces.</CardDescription>
        </CardHeader>
        <div className="border-b border-slate-100 px-5 py-4 sm:px-6">
          <label htmlFor="admin-search" className="sr-only">
            Search workspaces
          </label>
          <Input id="admin-search" type="search" placeholder="Search by name or owner email…" className="max-w-sm" />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workspace</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell colSpan={4}>
                <EmptyState
                  title="No workspaces to review"
                  description="Workspace directory and moderation tools arrive with the admin panel integration."
                />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
          <CardDescription>Irreversible platform actions. Confirmation is always required.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Badge variant="danger">Restricted</Badge>
            <p className="text-sm text-slate-600">Suspend a workspace and revoke all member access.</p>
          </div>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            Suspend workspace
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          toast({ title: "Preview only", description: "Suspension wires up with the admin integration.", variant: "info" });
        }}
        tone="danger"
        title="Suspend workspace?"
        message="Members will immediately lose access and all integrations will pause. This demonstrates the confirmation pattern."
        confirmLabel="Suspend"
      />
    </div>
  );
}
