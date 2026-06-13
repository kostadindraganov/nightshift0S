// HTTP client for the Nightshift API.
// All requests are same-origin; the server is expected to serve both the SPA
// and the API.  Request bodies use snake_case; responses are camelCase.
import type {
  Task,
  Project,
  NightshiftEvent,
  ConfigEntry,
  ThreadEvent,
  Finding,
  SettingsRegistryEntry,
  SettingsResponse,
  ProviderHealth,
  Routine,
  Trigger,
  TranscriptEvent,
} from "./types.ts";

// ── Token helpers ────────────────────────────────────────────
const TOKEN_KEY = "nightshift_token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// ── ApiError ─────────────────────────────────────────────────
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

// ── Core fetch wrapper ────────────────────────────────────────
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };

  const res = await fetch(path, { ...init, headers });

  if (!res.ok) {
    let code = "unknown_error";
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // ignore JSON parse failure; use statusText
    }
    throw new ApiError(res.status, code, message);
  }

  return res.json() as Promise<T>;
}

// ── Typed helpers ─────────────────────────────────────────────

export function listProjects(): Promise<Project[]> {
  return apiFetch<Project[]>("/projects");
}

export function createProject(body: {
  name: string;
  repo_url: string;
  default_branch?: string;
}): Promise<Project> {
  return apiFetch<Project>("/projects", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function listTasks(params?: {
  project_id?: number;
  state?: string;
}): Promise<Task[]> {
  const qs = params
    ? "?" + new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)])
      ).toString()
    : "";
  return apiFetch<Task[]>(`/tasks${qs}`);
}

export function getTask(id: number): Promise<Task> {
  return apiFetch<Task>(`/tasks/${id}`);
}

export function createTask(body: {
  project_id: number;
  title: string;
  description?: string;
  acceptance_criteria?: string;
  state?: string;
  priority?: number;
  category?: string;
  risk_tier?: string;
}): Promise<Task> {
  return apiFetch<Task>("/tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateTask(id: number, patch: Record<string, unknown>): Promise<Task> {
  return apiFetch<Task>(`/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteTask(id: number): Promise<void> {
  return apiFetch<void>(`/tasks/${id}`, { method: "DELETE" });
}

export function transitionTask(
  id: number,
  body: {
    to: string;
    expected_from?: string;
    actor?: string;
    merge_sha?: string;
  }
): Promise<Task> {
  return apiFetch<Task>(`/tasks/${id}/transition`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getConfig(): Promise<ConfigEntry[]> {
  return apiFetch<ConfigEntry[]>("/config");
}

export { type NightshiftEvent };

export function getThread(taskId: number): Promise<ThreadEvent[]> {
  return apiFetch<ThreadEvent[]>(`/tasks/${taskId}/thread`);
}

export function getFindings(taskId: number, round?: number): Promise<Finding[]> {
  const qs = round !== undefined ? `?round=${round}` : "";
  return apiFetch<Finding[]>(`/tasks/${taskId}/findings${qs}`);
}

export function triggerReviewRound(
  taskId: number,
): Promise<{ ok: boolean; outcome?: string; round?: number }> {
  return apiFetch<{ ok: boolean; outcome?: string; round?: number }>(
    `/tasks/${taskId}/review-round`,
    { method: "POST" },
  );
}

export function postVerdict(
  taskId: number,
  body: { decision: "resume_coding" | "force_merge" | "reject"; actor?: string },
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/tasks/${taskId}/verdict`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Promote a draft task to backlog, optionally expanding it with the planner. */
export function promoteDraft(
  taskId: number,
  body: { actor?: string; expand?: boolean },
): Promise<{ task: Task; expanded: boolean }> {
  return apiFetch<{ task: Task; expanded: boolean }>(`/tasks/${taskId}/promote`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Bulk-create draft tasks from a markdown bullet list. */
export function importDraftTasks(body: {
  project_id: number;
  markdown: string;
}): Promise<Task[]> {
  return apiFetch<Task[]>("/tasks/import-drafts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Bootstrap a project backlog from a freeform description via the planner (task 4.3). */
export function bootstrapProject(
  projectId: number,
  description: string,
): Promise<{ ok: boolean; tasks: { id: number; title: string }[] }> {
  return apiFetch<{ ok: boolean; tasks: { id: number; title: string }[] }>(
    `/projects/${projectId}/bootstrap`,
    { method: "POST", body: JSON.stringify({ description }) },
  );
}

// ── Editable settings registry (5.2, §3.12.19) ─────────────────
export function getSettingsRegistry(): Promise<SettingsRegistryEntry[]> {
  return apiFetch<SettingsRegistryEntry[]>("/settings/registry");
}

export function getSettings(params?: {
  project_id?: number;
  routine_id?: number;
}): Promise<SettingsResponse> {
  const qs = params
    ? "?" +
      new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : "";
  return apiFetch<SettingsResponse>(`/settings${qs}`);
}

export function putSetting(
  scope: string,
  key: string,
  body: { value: unknown; scope_id?: number; updated_by?: string },
): Promise<unknown> {
  return apiFetch<unknown>(`/settings/${scope}/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function deleteSetting(
  scope: string,
  key: string,
  scopeId?: number,
): Promise<{ ok: boolean }> {
  const qs = scopeId !== undefined ? `?scope_id=${scopeId}` : "";
  return apiFetch<{ ok: boolean }>(
    `/settings/${scope}/${encodeURIComponent(key)}${qs}`,
    { method: "DELETE" },
  );
}

export function getSettingsAudit(limit?: number): Promise<NightshiftEvent[]> {
  const qs = limit !== undefined ? `?limit=${limit}` : "";
  return apiFetch<NightshiftEvent[]>(`/settings/audit${qs}`);
}

// ── Provider auth health (5.8, §3.9) ───────────────────────────
export function getProvidersHealth(): Promise<ProviderHealth[]> {
  return apiFetch<ProviderHealth[]>("/providers/health");
}

// ── Routines + triggers (5.8, §3.2/§3.12.6) ────────────────────
export function listRoutines(params?: {
  project_id?: number;
  kind?: string;
}): Promise<Routine[]> {
  const qs = params
    ? "?" +
      new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : "";
  return apiFetch<Routine[]>(`/routines${qs}`);
}

export function createRoutine(body: Record<string, unknown>): Promise<Routine> {
  return apiFetch<Routine>("/routines", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteRoutine(id: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/routines/${id}`, { method: "DELETE" });
}

export function listTriggers(params?: {
  routine_id?: number;
}): Promise<Trigger[]> {
  const qs = params?.routine_id !== undefined ? `?routine_id=${params.routine_id}` : "";
  return apiFetch<Trigger[]>(`/triggers${qs}`);
}

export function createTrigger(body: Record<string, unknown>): Promise<Trigger> {
  return apiFetch<Trigger>("/triggers", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteTrigger(id: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/triggers/${id}`, { method: "DELETE" });
}

export function fireTrigger(
  id: number,
  body?: { actor?: string; dedupe_key?: string },
): Promise<{ ok: boolean; task_id?: number }> {
  return apiFetch<{ ok: boolean; task_id?: number }>(`/triggers/${id}/fire`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

// ── Transcript browser (5.8, §3.12.16) ─────────────────────────
export function getTaskTranscript(
  taskId: number,
  params?: { round?: number; after_seq?: number; limit?: number },
): Promise<TranscriptEvent[]> {
  const qs = params
    ? "?" +
      new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : "";
  return apiFetch<TranscriptEvent[]>(`/tasks/${taskId}/transcript${qs}`);
}

export function getRunTranscript(runId: number): Promise<TranscriptEvent[]> {
  return apiFetch<TranscriptEvent[]>(`/runs/${runId}/transcript`);
}
