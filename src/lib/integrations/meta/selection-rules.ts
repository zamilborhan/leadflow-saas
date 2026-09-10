/**
 * Pure Page/Form selection rules (no imports at all, so unit tests exercise
 * the exact decision logic the service layer enforces).
 *
 * These functions operate on already-fetched Meta lists — all network I/O
 * stays in MetaGraphClient, all persistence in pages.ts. Failures use the
 * local SelectionNotFound / SelectionConflict classes, which pages.ts
 * translates to the tenancy TenantNotFound / TenantConflict errors so HTTP
 * mappings stay identical (404 unknown, 409 precondition). The classes live
 * here (rather than importing policies.ts) because Node's type-stripping
 * cannot resolve extensionless project imports in directly-tested modules.
 */
import type { MetaLeadFormInfo, MetaPageInfo } from "./client";

export class SelectionNotFound extends Error {
  constructor(message = "Not found.") {
    super(message);
    this.name = "SelectionNotFound";
  }
}

export class SelectionConflict extends Error {
  constructor(message = "Conflicting state.") {
    super(message);
    this.name = "SelectionConflict";
  }
}

export interface AvailablePage {
  metaPageId: string;
  name: string;
  tasks: string[];
  /** Whether the user may select this page for lead work. */
  selectable: boolean;
  selected: boolean;
}

export interface AvailableForm {
  metaFormId: string;
  name: string;
  status: string;
  connected: boolean;
}

/** Lead work requires the ADVERTISE (or MANAGE) Page task, per Meta's docs. */
export function pageSelectable(tasks: string[]): boolean {
  return tasks.includes("ADVERTISE") || tasks.includes("MANAGE");
}

/**
 * Resolve a Page id against the live account list. Unknown ids map to 404
 * (indistinguishable from "not in this account"); missing tasks or a
 * missing Page token map to 409 with an actionable message.
 */
export interface SelectablePage extends MetaPageInfo {
  pageToken: string;
}

export function pickSelectablePage(pages: MetaPageInfo[], metaPageId: string): SelectablePage {
  if (!metaPageId) throw new SelectionConflict("A Page id is required.");
  const match = pages.find((p) => p.id === metaPageId) ?? null;
  if (!match) throw new SelectionNotFound("Page not found in the connected account.");
  if (!pageSelectable(match.tasks)) {
    throw new SelectionConflict("This Page does not grant advertising access.");
  }
  if (!match.pageToken) {
    throw new SelectionConflict("Meta did not issue a token for this Page. Reconnect and try again.");
  }
  return { ...match, pageToken: match.pageToken };
}

/**
 * Resolve a form id against the selected Page's live form list. Unknown
 * ids map to 404; non-ACTIVE forms map to 409 (Meta only delivers leadgen
 * webhooks for active forms).
 */
export function pickConnectableForm(forms: MetaLeadFormInfo[], metaFormId: string): MetaLeadFormInfo {
  if (!metaFormId) throw new SelectionConflict("A form id is required.");
  const match = forms.find((f) => f.id === metaFormId) ?? null;
  if (!match) throw new SelectionNotFound("Form not found on the selected Page.");
  if (match.status !== "ACTIVE") {
    throw new SelectionConflict("Only ACTIVE forms can be connected.");
  }
  return match;
}

/** Merge a live Page list with persisted selection flags. */
export function toAvailablePages(live: MetaPageInfo[], selectedIds: Set<string>): AvailablePage[] {
  return live.map((p) => ({
    metaPageId: p.id,
    name: p.name,
    tasks: p.tasks,
    selectable: pageSelectable(p.tasks),
    selected: selectedIds.has(p.id),
  }));
}

/** Merge a live form list with persisted connected flags. */
export function toAvailableForms(
  live: MetaLeadFormInfo[],
  connectedIds: Set<string>
): AvailableForm[] {
  return live.map((f) => ({
    metaFormId: f.id,
    name: f.name,
    status: f.status,
    connected: connectedIds.has(f.id),
  }));
}
