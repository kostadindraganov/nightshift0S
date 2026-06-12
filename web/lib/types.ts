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

export interface ThreadEvent {
  id: number;
  taskId: number;
  seq: number;
  kind: "message" | "finding" | "rebuttal" | "verdict" | "system" | "human" | "artifact";
  actor: string;
  round: number;
  runId: number | null;
  idempotencyKey: string | null;
  payloadJson: string;
  artifactRefs: string | null;
  redacted: boolean;
  createdAt: string;
}

export interface Finding {
  id: number;
  taskId: number;
  round: number;
  runId: number | null;
  severity: "critical" | "high" | "medium" | "low" | "nit";
  confidence: number;
  commitSha: string;
  filePathOld: string | null;
  filePathNew: string | null;
  hunkContext: string | null;
  description: string;
  suggestion: string | null;
  resolutionState: "open" | "fixed" | "rebutted" | "withdrawn" | "accepted_risk";
  resolvedRound: number | null;
}

export interface Verdict {
  verdict: "approved" | "revise";
  summary: string;
  findings: unknown[]; // payload-embedded; render from Finding rows instead
}
