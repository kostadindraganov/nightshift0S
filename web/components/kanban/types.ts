// Shared types for the kanban board components.
// Mirrors api Task shape plus UI-only helpers.
import type { Task, TaskState } from "../../lib/types.ts";

export type { Task, TaskState };

// The 8 visual columns and which TaskStates they contain.
export type ColumnId =
  | "draft"
  | "backlog"
  | "ready"
  | "coding"
  | "review"
  | "approved"
  | "done"
  | "attention";

export interface ColumnDef {
  id: ColumnId;
  label: string;
  states: TaskState[];
  /** Target state when a card is dropped here (null = blocked). */
  targetState: TaskState | null;
  /** If true, drop is blocked (system-only or needs extra data). */
  dropBlocked: boolean;
  dropBlockReason?: string;
}

export const COLUMNS: ColumnDef[] = [
  {
    id: "draft",
    label: "To-Do",
    states: ["draft"],
    targetState: null,
    dropBlocked: true,
    dropBlockReason: "drop draft here via Promote button",
  },
  {
    id: "backlog",
    label: "Backlog",
    states: ["backlog"],
    targetState: "backlog",
    dropBlocked: false,
  },
  {
    id: "ready",
    label: "Ready",
    states: ["ready"],
    targetState: null,
    dropBlocked: true,
    dropBlockReason: "ready is system-only (deps_merged transition)",
  },
  {
    id: "coding",
    label: "Coding",
    states: ["coding"],
    targetState: "coding",
    dropBlocked: false,
  },
  {
    id: "review",
    label: "Review",
    states: ["review"],
    targetState: "review",
    dropBlocked: false,
  },
  {
    id: "approved",
    label: "Approved",
    states: ["approved", "merging"],
    targetState: "approved",
    dropBlocked: false,
  },
  {
    id: "done",
    label: "Done",
    states: ["done"],
    targetState: null,
    dropBlocked: true,
    dropBlockReason: "done requires merge_sha (merging->done only)",
  },
  {
    id: "attention",
    label: "Attention",
    states: ["needs_human", "failed", "cancelled"],
    targetState: "needs_human",
    dropBlocked: false,
  },
];

// Map each TaskState -> ColumnId for O(1) lookup.
export const STATE_TO_COLUMN: Record<TaskState, ColumnId> = {
  draft: "draft",
  backlog: "backlog",
  ready: "ready",
  coding: "coding",
  review: "review",
  approved: "approved",
  merging: "approved",
  done: "done",
  needs_human: "attention",
  failed: "attention",
  cancelled: "attention",
};

// Legal state-machine edges from the task spec.
// Terminal states (done, cancelled) never appear as a FROM here.
type Edge = `${TaskState}->${TaskState}`;
export const LEGAL_EDGES = new Set<Edge>([
  "draft->backlog",
  "backlog->ready", // system-only, but still in the set — gated separately
  "ready->coding",
  "coding->review",
  "coding->failed",
  "review->coding",
  "review->approved",
  "review->needs_human",
  "approved->merging",
  "merging->done", // needs merge_sha, blocked in UI
  "merging->needs_human",
  "failed->backlog",
  "needs_human->coding",
  "needs_human->merging",
  // ANY non-terminal -> cancelled
  "draft->cancelled",
  "backlog->cancelled",
  "ready->cancelled",
  "coding->cancelled",
  "review->cancelled",
  "approved->cancelled",
  "merging->cancelled",
  "needs_human->cancelled",
  "failed->cancelled",
]);

export const SYSTEM_ONLY_EDGES = new Set<Edge>(["backlog->ready"]);
export const NEEDS_MERGE_SHA_EDGES = new Set<Edge>(["merging->done"]);

// States a task may be deleted from — mirrors the server's DELETABLE_STATES
// (parked states only; mid-flight tasks must be cancelled first).
export const DELETABLE_STATES = new Set<TaskState>([
  "draft",
  "backlog",
  "cancelled",
  "done",
]);
