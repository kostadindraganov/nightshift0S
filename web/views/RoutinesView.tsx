// RoutinesView — manage routines + their triggers and fire them (Phase 5 task 5.8).
// Load routines, create new routines with name/kind/promptName/reviewPolicy/project.
// Select a routine to view its triggers, add triggers, and fire manual triggers.

import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Routine, Project, Trigger } from "../lib/types";

export default function RoutinesView() {
  // Routines list + creation form
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [selectedRoutineId, setSelectedRoutineId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create routine form
  const [createName, setCreateName] = useState("");
  const [createKind, setCreateKind] = useState<"task" | "experiment">("task");
  const [createPromptName, setCreatePromptName] = useState("");
  const [createReviewPolicy, setCreateReviewPolicy] = useState<"full" | "light" | "none">(
    "full"
  );
  const [createProjectId, setCreateProjectId] = useState<number | "">();
  const [projects, setProjects] = useState<Project[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);

  // Triggers for selected routine
  const [triggers, setTriggers] = useState<Trigger[] | null>(null);
  const [triggersLoading, setTriggersLoading] = useState(false);
  const [triggersError, setTriggersError] = useState<string | null>(null);

  // Add trigger form
  const [addTriggerKind, setAddTriggerKind] = useState<"manual" | "cron">("manual");
  const [addTriggerSchedule, setAddTriggerSchedule] = useState("");
  const [addTriggerDryRunDefault, setAddTriggerDryRunDefault] = useState(false);
  const [addTriggerError, setAddTriggerError] = useState<string | null>(null);

  // Fire trigger state
  const [fireResults, setFireResults] = useState<Record<number, string>>({});

  // Load routines and projects on mount
  useEffect(() => {
    void (async () => {
      try {
        setLoading(true);
        setError(null);
        const [r, p] = await Promise.all([api.listRoutines(), api.listProjects()]);
        setRoutines(r);
        setProjects(p);
      } catch (err) {
        const msg = err instanceof api.ApiError ? err.message : "Failed to load routines";
        setError(msg);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Load triggers when routine is selected
  useEffect(() => {
    if (selectedRoutineId === null) {
      setTriggers(null);
      return;
    }
    void (async () => {
      try {
        setTriggersLoading(true);
        setTriggersError(null);
        const t = await api.listTriggers({ routine_id: selectedRoutineId });
        setTriggers(t);
      } catch (err) {
        const msg = err instanceof api.ApiError ? err.message : "Failed to load triggers";
        setTriggersError(msg);
      } finally {
        setTriggersLoading(false);
      }
    })();
  }, [selectedRoutineId]);

  async function handleCreateRoutine() {
    setCreateError(null);
    if (!createName.trim() || !createPromptName.trim()) {
      setCreateError("Name and prompt name are required");
      return;
    }
    try {
      const body: Record<string, unknown> = {
        name: createName.trim(),
        kind: createKind,
        prompt_name: createPromptName.trim(),
        review_policy: createReviewPolicy,
      };
      if (createProjectId) {
        body.project_id = createProjectId;
      }
      const created = await api.createRoutine(body);
      setRoutines([...(routines ?? []), created]);
      setCreateName("");
      setCreatePromptName("");
      setCreateKind("task");
      setCreateReviewPolicy("full");
      setCreateProjectId("");
    } catch (err) {
      const msg = err instanceof api.ApiError ? err.message : "Failed to create routine";
      setCreateError(msg);
    }
  }

  async function handleDeleteRoutine(id: number) {
    try {
      await api.deleteRoutine(id);
      setRoutines((r) => r?.filter((x) => x.id !== id) ?? null);
      if (selectedRoutineId === id) {
        setSelectedRoutineId(null);
      }
    } catch (err) {
      const msg = err instanceof api.ApiError ? err.message : "Failed to delete routine";
      setTriggersError(msg);
    }
  }

  async function handleAddTrigger() {
    setAddTriggerError(null);
    if (selectedRoutineId === null) return;
    if (addTriggerKind === "cron" && !addTriggerSchedule.trim()) {
      setAddTriggerError("Schedule is required for cron triggers");
      return;
    }
    try {
      const body: Record<string, unknown> = {
        routine_id: selectedRoutineId,
        kind: addTriggerKind,
        dry_run_default: addTriggerDryRunDefault,
      };
      if (addTriggerKind === "cron") {
        body.schedule = addTriggerSchedule.trim();
      }
      const created = await api.createTrigger(body);
      setTriggers([...(triggers ?? []), created]);
      setAddTriggerKind("manual");
      setAddTriggerSchedule("");
      setAddTriggerDryRunDefault(false);
    } catch (err) {
      const msg = err instanceof api.ApiError ? err.message : "Failed to add trigger";
      setAddTriggerError(msg);
    }
  }

  async function handleDeleteTrigger(id: number) {
    try {
      await api.deleteTrigger(id);
      setTriggers((t) => t?.filter((x) => x.id !== id) ?? null);
      setFireResults((r) => {
        const copy = { ...r };
        delete copy[id];
        return copy;
      });
    } catch (err) {
      const msg = err instanceof api.ApiError ? err.message : "Failed to delete trigger";
      setTriggersError(msg);
    }
  }

  async function handleFireTrigger(id: number) {
    try {
      setFireResults((r) => ({ ...r, [id]: "firing..." }));
      const result = await api.fireTrigger(id, { actor: "ui" });
      if (result.ok && result.task_id) {
        setFireResults((r) => ({
          ...r,
          [id]: `fired: task #${result.task_id}`,
        }));
      } else {
        setFireResults((r) => ({ ...r, [id]: "fire failed" }));
      }
    } catch (err) {
      const msg = err instanceof api.ApiError ? err.message : "Fire failed";
      setFireResults((r) => ({ ...r, [id]: msg }));
    }
  }

  const selectedRoutine = routines?.find((r) => r.id === selectedRoutineId);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: "var(--color-canvas)",
        color: "var(--color-body)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "var(--space-xl) var(--space-xl) var(--space-md) var(--space-xl)",
          borderBottom: "1px solid var(--color-hairline)",
        }}
      >
        <h1 className="t-title-lg" style={{ marginBottom: "var(--space-xs)" }}>
          Routines
        </h1>
        <p className="t-caption" style={{ color: "var(--color-muted)" }}>
          Reusable task templates with manual/cron triggers
        </p>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-xl)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "var(--space-lg)",
        }}
      >
        {/* Left: Create form + routines list */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-lg)",
          }}
        >
          {/* Create Routine Card */}
          <div
            style={{
              backgroundColor: "var(--color-surface-card)",
              border: "1px solid var(--color-hairline)",
              borderRadius: "var(--radius-lg)",
              padding: "var(--space-md)",
            }}
          >
            <h2 className="t-title-md" style={{ marginBottom: "var(--space-md)", color: "var(--color-ink)" }}>
              Create Routine
            </h2>

            <label style={fieldStyle}>
              <span style={labelStyle}>Name</span>
              <input
                style={inputStyle}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="my-routine"
              />
            </label>

            <label style={fieldStyle}>
              <span style={labelStyle}>Kind</span>
              <select
                style={inputStyle}
                value={createKind}
                onChange={(e) => setCreateKind(e.target.value as "task" | "experiment")}
              >
                <option value="task">task</option>
                <option value="experiment">experiment</option>
              </select>
            </label>

            <label style={fieldStyle}>
              <span style={labelStyle}>Prompt Name</span>
              <input
                style={inputStyle}
                value={createPromptName}
                onChange={(e) => setCreatePromptName(e.target.value)}
                placeholder="my-prompt"
              />
            </label>

            <label style={fieldStyle}>
              <span style={labelStyle}>Review Policy</span>
              <select
                style={inputStyle}
                value={createReviewPolicy}
                onChange={(e) =>
                  setCreateReviewPolicy(e.target.value as "full" | "light" | "none")
                }
              >
                <option value="full">full</option>
                <option value="light">light</option>
                <option value="none">none</option>
              </select>
            </label>

            <label style={fieldStyle}>
              <span style={labelStyle}>Project (optional)</span>
              <select
                style={inputStyle}
                value={String(createProjectId ?? "")}
                onChange={(e) => setCreateProjectId(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">Global</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            {createError && (
              <div
                style={{
                  backgroundColor: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid var(--color-accent-rose)",
                  borderRadius: "var(--radius-md)",
                  padding: "var(--space-sm)",
                  marginBottom: "var(--space-sm)",
                }}
              >
                <p className="t-body-sm" style={{ color: "var(--color-accent-rose)", margin: 0 }}>
                  {createError}
                </p>
              </div>
            )}

            <button className="btn-primary" onClick={handleCreateRoutine}>
              Create
            </button>
          </div>

          {/* Routines List */}
          {loading && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: 200,
                color: "var(--color-muted)",
              }}
            >
              <span className="t-body-sm">Loading…</span>
            </div>
          )}

          {error && (
            <div
              style={{
                backgroundColor: "rgba(239, 68, 68, 0.1)",
                border: "1px solid var(--color-accent-rose)",
                borderRadius: "var(--radius-lg)",
                padding: "var(--space-md)",
              }}
            >
              <p className="t-body-sm" style={{ color: "var(--color-accent-rose)" }}>
                {error}
              </p>
            </div>
          )}

          {!loading && routines && routines.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
              {routines.map((r) => (
                <div
                  key={r.id}
                  onClick={() => setSelectedRoutineId(r.id)}
                  style={{
                    backgroundColor:
                      selectedRoutineId === r.id ? "var(--color-accent-blue)" : "var(--color-surface-card)",
                    border:
                      selectedRoutineId === r.id
                        ? "1px solid var(--color-accent-blue)"
                        : "1px solid var(--color-hairline)",
                    borderRadius: "var(--radius-md)",
                    padding: "var(--space-sm)",
                    cursor: "pointer",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div
                      className="t-body-sm"
                      style={{
                        color:
                          selectedRoutineId === r.id ? "var(--color-on-primary)" : "var(--color-ink)",
                        fontWeight: 600,
                      }}
                    >
                      {r.name}
                    </div>
                    <div className="t-caption" style={{ color: "var(--color-muted)", marginTop: 2 }}>
                      {r.kind} • {r.promptName} • {r.reviewPolicy}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteRoutine(r.id);
                    }}
                    style={{
                      padding: "var(--space-xxs) var(--space-xs)",
                      backgroundColor: "rgba(239, 68, 68, 0.2)",
                      border: "1px solid var(--color-accent-rose)",
                      borderRadius: "var(--radius-md)",
                      color: "var(--color-accent-rose)",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}

          {!loading && routines && routines.length === 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: 200,
                color: "var(--color-muted)",
              }}
            >
              <span className="t-body-sm">No routines yet</span>
            </div>
          )}
        </div>

        {/* Right: Triggers for selected routine */}
        {selectedRoutine && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-lg)",
            }}
          >
            {/* Triggers List */}
            <div
              style={{
                backgroundColor: "var(--color-surface-card)",
                border: "1px solid var(--color-hairline)",
                borderRadius: "var(--radius-lg)",
                padding: "var(--space-md)",
              }}
            >
              <h2 className="t-title-md" style={{ marginBottom: "var(--space-md)", color: "var(--color-ink)" }}>
                Triggers
              </h2>

              {triggersLoading && <span className="t-body-sm" style={{ color: "var(--color-muted)" }}>Loading triggers…</span>}

              {triggersError && (
                <div
                  style={{
                    backgroundColor: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid var(--color-accent-rose)",
                    borderRadius: "var(--radius-md)",
                    padding: "var(--space-sm)",
                    marginBottom: "var(--space-md)",
                  }}
                >
                  <p className="t-body-sm" style={{ color: "var(--color-accent-rose)", margin: 0 }}>
                    {triggersError}
                  </p>
                </div>
              )}

              {triggers && triggers.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)", marginBottom: "var(--space-md)" }}>
                  {triggers.map((t) => (
                    <div
                      key={t.id}
                      style={{
                        backgroundColor: "var(--color-canvas)",
                        border: "1px solid var(--color-hairline)",
                        borderRadius: "var(--radius-md)",
                        padding: "var(--space-sm)",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "var(--space-xs)" }}>
                        <div>
                          <div className="t-body-sm" style={{ color: "var(--color-ink)", fontWeight: 600 }}>
                            {t.kind}
                            {t.kind === "cron" && ` • ${t.schedule}`}
                          </div>
                          <div className="t-caption" style={{ color: "var(--color-muted)" }}>
                            Dry run: {t.dryRunDefault ? "yes" : "no"} • {t.enabled ? "enabled" : "disabled"}
                            {t.lastFiredAt && ` • Last: ${new Date(t.lastFiredAt).toLocaleString()}`}
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteTrigger(t.id)}
                          style={{
                            padding: "var(--space-xxs) var(--space-xs)",
                            backgroundColor: "rgba(239, 68, 68, 0.2)",
                            border: "1px solid var(--color-accent-rose)",
                            borderRadius: "var(--radius-md)",
                            color: "var(--color-accent-rose)",
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          Delete
                        </button>
                      </div>
                      {t.kind === "manual" && (
                        <button
                          onClick={() => handleFireTrigger(t.id)}
                          style={{
                            padding: "var(--space-xxs) var(--space-xs)",
                            backgroundColor: "var(--color-primary)",
                            color: "var(--color-on-primary)",
                            border: "1px solid var(--color-primary)",
                            borderRadius: "var(--radius-md)",
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: "pointer",
                            marginBottom: fireResults[t.id] ? "var(--space-xs)" : 0,
                          }}
                        >
                          Fire now
                        </button>
                      )}
                      {fireResults[t.id] && (
                        <div className="t-caption" style={{ color: "var(--color-muted)", marginTop: "var(--space-xs)" }}>
                          {fireResults[t.id]}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {!triggersLoading && triggers && triggers.length === 0 && (
                <div style={{ color: "var(--color-muted)", marginBottom: "var(--space-md)" }}>
                  <span className="t-body-sm">No triggers yet</span>
                </div>
              )}
            </div>

            {/* Add Trigger Form */}
            <div
              style={{
                backgroundColor: "var(--color-surface-card)",
                border: "1px solid var(--color-hairline)",
                borderRadius: "var(--radius-lg)",
                padding: "var(--space-md)",
              }}
            >
              <h2 className="t-title-md" style={{ marginBottom: "var(--space-md)", color: "var(--color-ink)" }}>
                Add Trigger
              </h2>

              <label style={fieldStyle}>
                <span style={labelStyle}>Kind</span>
                <select
                  style={inputStyle}
                  value={addTriggerKind}
                  onChange={(e) => setAddTriggerKind(e.target.value as "manual" | "cron")}
                >
                  <option value="manual">manual</option>
                  <option value="cron">cron</option>
                </select>
              </label>

              {addTriggerKind === "cron" && (
                <label style={fieldStyle}>
                  <span style={labelStyle}>Schedule (cron)</span>
                  <input
                    style={inputStyle}
                    value={addTriggerSchedule}
                    onChange={(e) => setAddTriggerSchedule(e.target.value)}
                    placeholder="0 3 * * *"
                  />
                </label>
              )}

              <label style={{ ...fieldStyle, marginBottom: "var(--space-md)" }}>
                <span style={labelStyle}>Dry run by default</span>
                <input
                  type="checkbox"
                  checked={addTriggerDryRunDefault}
                  onChange={(e) => setAddTriggerDryRunDefault(e.target.checked)}
                  style={{ width: 16, height: 16, cursor: "pointer" }}
                />
              </label>

              {addTriggerError && (
                <div
                  style={{
                    backgroundColor: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid var(--color-accent-rose)",
                    borderRadius: "var(--radius-md)",
                    padding: "var(--space-sm)",
                    marginBottom: "var(--space-sm)",
                  }}
                >
                  <p className="t-body-sm" style={{ color: "var(--color-accent-rose)", margin: 0 }}>
                    {addTriggerError}
                  </p>
                </div>
              )}

              <button className="btn-primary" onClick={handleAddTrigger}>
                Add
              </button>
            </div>
          </div>
        )}

        {!selectedRoutine && routines && routines.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: 300,
              color: "var(--color-muted)",
            }}
          >
            <span className="t-body-sm">Select a routine to view triggers</span>
          </div>
        )}
      </div>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  marginBottom: "var(--space-md)",
};

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-muted)",
  letterSpacing: 0.2,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "var(--space-xs) var(--space-sm)",
  background: "var(--color-canvas)",
  border: "1px solid var(--color-hairline)",
  borderRadius: "var(--radius-md)",
  color: "var(--color-ink)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
};
