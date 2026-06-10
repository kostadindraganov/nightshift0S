// HTTP client for the Nightshift API.
// All requests are same-origin; the server is expected to serve both the SPA
// and the API.  Request bodies use snake_case; responses are camelCase.
import type { Task, Project, NightshiftEvent, ConfigEntry } from "./types.ts";

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
