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

// ── Editable settings registry (5.2, §3.12.19) ─────────────────
/** One editable knob definition from GET /settings/registry. */
export interface SettingsRegistryEntry {
  key: string;
  configPath: string;
  type: "number" | "boolean" | "string" | "stringArray";
  scopes: string[];
  secret: boolean;
  default: unknown;
}

/** One effective config leaf from GET /settings (post layering). */
export interface EffectiveSetting {
  path: string;
  value: unknown;
  source: string; // default | file | env | db:global | db:project | db:routine
}

/** A scoped override row (secret values masked). */
export interface SettingOverride {
  id: number;
  scope: string;
  scopeId: number | null;
  key: string;
  valueJson: string;
  valueMasked: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface SettingsResponse {
  entries: EffectiveSetting[];
  overrides: SettingOverride[];
}

// ── Provider auth health (5.8, §3.9) ───────────────────────────
export interface ProviderHealth {
  name: string;
  kind: string;
  authMode: string;
  enabled: boolean;
  circuitState: string;
  cooldownUntil: string | null;
  cooldownActive: boolean;
  lastError: string | null;
  capabilitiesProven: boolean;
  status:
    | "healthy"
    | "degraded"
    | "cooling_down"
    | "circuit_open"
    | "disabled"
    | "unproven";
}

// ── Routines + triggers (5.8, §3.2/§3.12.6) ────────────────────
export interface Routine {
  id: number;
  projectId: number | null;
  name: string;
  kind: "task" | "experiment";
  promptName: string;
  paramsJson: string | null;
  providerPref: string | null;
  rubric: string | null;
  budgetJson: string | null;
  reviewPolicy: "full" | "light" | "none";
  enabled: boolean;
}

export interface Trigger {
  id: number;
  routineId: number;
  kind: "manual" | "cron" | "webhook" | "chat";
  schedule: string | null;
  authzJson: string | null;
  dryRunDefault: boolean;
  enabled: boolean;
  lastFiredAt: string | null;
}

// ── Analytics + evidence-based routing (Phase 6, §3.7) ─────────
export interface ProviderStat {
  provider: string;
  total: number;
  succeeded: number;
  failed: number;
  successRate: number;
  avgDurationMs: number | null;
  totalCostUsd: number;
  pricedRuns: number;
  topExitReasons: { reason: string; count: number }[];
}

export interface FactoryOverview {
  tasksByState: Record<string, number>;
  runsByState: Record<string, number>;
  totalCostUsd: number;
  activeRuns: number;
}

export interface RoutingScore {
  provider: string;
  score: number;
  reason: string;
}

export interface AnalyticsResponse {
  overview: FactoryOverview;
  providers: ProviderStat[];
  routing: RoutingScore[];
}

// ── Transcript browser (5.8, §3.12.16) ─────────────────────────
export interface TranscriptEvent {
  seq: number;
  ts: string;
  source: "event" | "thread";
  kind: string;
  actor?: string;
  runId?: number | null;
  round?: number | null;
  idempotencyKey?: string | null;
  redacted?: boolean;
  payload: unknown;
}
