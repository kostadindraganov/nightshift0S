// Shared TypeScript interfaces mirroring the Nightshift API's camelCase response shapes.
// Request bodies (snake_case) are typed inline at the call sites in api.ts.

export type TaskState =
  | "draft"
  | "backlog"
  | "ready"
  | "coding"
  | "review"
  | "approved"
  | "merging"
  | "needs_human"
  | "done"
  | "failed"
  | "cancelled";

export interface Task {
  id: number;
  projectId: number;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  state: TaskState;
  priority: number;
  category: string | null;
  riskTier: string;
  branch: string | null;
  baseSha: string | null;
  mergeSha: string | null;
  claimedBy: string | null;
  round: number;
  routineId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NightshiftEvent {
  id: number;
  projectId: number | null;
  runId: string | null;
  taskId: number | null;
  seq: number;
  kind: string;
  /** Raw JSON string — callers must JSON.parse() as needed. */
  payloadJson: string;
  ts: string;
}

export interface Project {
  id: number;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  settingsJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

/** One row from GET /config */
export interface ConfigEntry {
  section: string;
  key: string;
  value: unknown;
  source: string;
  secret: boolean;
  scope: string;
}
