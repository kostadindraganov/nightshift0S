// Memory view — per-project agent memory browser/editor (Phase 6, §3 Memory).
// Load memory rows by project, edit/delete entries, grouped by namespace.

import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { AgentMemory, Project } from "../lib/types";

interface MemoryRow {
  id: number;
  namespace: string;
  key: string;
  value: unknown;
  source: string;
  updatedAt: string;
}

interface EditFormState {
  namespace: string;
  key: string;
  value: string;
}

export default function MemoryView() {
  // Projects + selection
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);

  // Memory rows
  const [memory, setMemory] = useState<MemoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add/edit form
  const [formNamespace, setFormNamespace] = useState("note");
  const [formKey, setFormKey] = useState("");
  const [formValue, setFormValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSaving, setFormSaving] = useState(false);

  // Load projects on mount
  useEffect(() => {
    void (async () => {
      try {
        const p = await api.listProjects();
        setProjects(p);
        if (p.length > 0 && p[0]) {
          setSelectedProjectId(p[0]!.id);
        }
      } catch (err) {
        const msg = err instanceof api.ApiError ? err.message : "Failed to load projects";
        setError(msg);
      }
    })();
  }, []);

  // Load memory when project changes
  useEffect(() => {
    if (selectedProjectId === null) {
      setMemory([]);
      return;
    }
    const pid = selectedProjectId;
    void (async () => {
      try {
        setLoading(true);
        setError(null);
        const rows = await api.getProjectMemory(pid);
        const parsed: MemoryRow[] = rows.map((r) => ({
          id: r.id,
          namespace: r.namespace,
          key: r.key,
          value: (() => {
            try {
              return JSON.parse(String(r.valueJson));
            } catch {
              return r.valueJson;
            }
          })(),
          source: r.source,
          updatedAt: r.updatedAt,
        }));
        setMemory(parsed);
      } catch (err) {
        const msg = err instanceof api.ApiError ? err.message : "Failed to load memory";
        setError(msg);
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedProjectId]);

  async function handleSaveMemory() {
    setFormError(null);
    if (!formKey.trim()) {
      setFormError("Key is required");
      return;
    }
    if (selectedProjectId === null) return;

    const pid = selectedProjectId;
    try {
      setFormSaving(true);
      await api.putProjectMemory(pid, formKey.trim(), {
        value: formValue.trim(),
        namespace: formNamespace.trim() || "note",
        source: "ui",
      });
      // Reload memory
      const rows = await api.getProjectMemory(pid);
      const parsed: MemoryRow[] = rows.map((r) => ({
        id: r.id,
        namespace: r.namespace,
        key: r.key,
        value: (() => {
          try {
            return JSON.parse(String(r.valueJson));
          } catch {
            return r.valueJson;
          }
        })(),
        source: r.source,
        updatedAt: r.updatedAt,
      }));
      setMemory(parsed);
      setFormKey("");
      setFormValue("");
      setFormNamespace("note");
    } catch (err) {
      const msg = err instanceof api.ApiError ? err.message : "Failed to save memory";
      setFormError(msg);
    } finally {
      setFormSaving(false);
    }
  }

  async function handleDeleteMemory(key: string, namespace: string) {
    if (selectedProjectId === null) return;
    const pid = selectedProjectId;
    try {
      await api.deleteProjectMemory(pid, key, namespace);
      setMemory((m) => m.filter((x) => x.key !== key || x.namespace !== namespace));
    } catch (err) {
      const msg = err instanceof api.ApiError ? err.message : "Failed to delete memory";
      setError(msg);
    }
  }

  // Group memory by namespace
  const groupedByNamespace = memory.reduce(
    (acc, row) => {
      if (!acc[row.namespace]) {
        acc[row.namespace] = [];
      }
      const ns = acc[row.namespace];
      if (ns) {
        ns.push(row);
      }
      return acc;
    },
    {} as Record<string, MemoryRow[]>
  );

  const namespaces = Object.keys(groupedByNamespace).sort();

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
          Memory
        </h1>
        <p className="t-caption" style={{ color: "var(--color-muted)" }}>
          Accumulated per-project learnings the factory carries across runs
        </p>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-xl)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-lg)",
        }}
      >
        {/* Project selector */}
        <div
          style={{
            backgroundColor: "var(--color-surface-card)",
            border: "1px solid var(--color-hairline)",
            borderRadius: "var(--radius-lg)",
            padding: "var(--space-md)",
          }}
        >
          <label style={fieldStyle}>
            <span style={labelStyle}>Project</span>
            <select
              style={inputStyle}
              value={selectedProjectId ?? ""}
              onChange={(e) => setSelectedProjectId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select a project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Add/edit form */}
        {selectedProjectId !== null && (
          <div
            style={{
              backgroundColor: "var(--color-surface-card)",
              border: "1px solid var(--color-hairline)",
              borderRadius: "var(--radius-lg)",
              padding: "var(--space-md)",
            }}
          >
            <h2 className="t-title-md" style={{ marginBottom: "var(--space-md)", color: "var(--color-ink)" }}>
              Add/Edit Entry
            </h2>

            <label style={fieldStyle}>
              <span style={labelStyle}>Namespace</span>
              <input
                style={inputStyle}
                value={formNamespace}
                onChange={(e) => setFormNamespace(e.target.value)}
                placeholder="note"
              />
            </label>

            <label style={fieldStyle}>
              <span style={labelStyle}>Key</span>
              <input
                style={inputStyle}
                value={formKey}
                onChange={(e) => setFormKey(e.target.value)}
                placeholder="my-key"
              />
            </label>

            <label style={fieldStyle}>
              <span style={labelStyle}>Value</span>
              <textarea
                style={{
                  ...inputStyle,
                  fontFamily: "var(--font-mono)",
                  minHeight: 100,
                  resize: "vertical",
                }}
                value={formValue}
                onChange={(e) => setFormValue(e.target.value)}
                placeholder="Enter value as string"
              />
            </label>

            {formError && (
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
                  {formError}
                </p>
              </div>
            )}

            <button
              className="btn-primary"
              onClick={handleSaveMemory}
              disabled={formSaving}
              style={{ opacity: formSaving ? 0.6 : 1 }}
            >
              {formSaving ? "Saving…" : "Save"}
            </button>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div
            style={{
              backgroundColor: "rgba(239, 68, 68, 0.1)",
              border: "1px solid var(--color-accent-rose)",
              borderRadius: "var(--radius-lg)",
              padding: "var(--space-md)",
            }}
          >
            <p
              className="t-body-sm"
              style={{
                color: "var(--color-accent-rose)",
                margin: 0,
              }}
            >
              {error}
            </p>
          </div>
        )}

        {/* Loading state */}
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

        {/* Memory rows grouped by namespace */}
        {!loading && selectedProjectId !== null && namespaces.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-lg)" }}>
            {namespaces.map((ns) => (
              <div
                key={ns}
                style={{
                  backgroundColor: "var(--color-surface-card)",
                  border: "1px solid var(--color-hairline)",
                  borderRadius: "var(--radius-lg)",
                  padding: "var(--space-md)",
                }}
              >
                <h3
                  className="t-title-md"
                  style={{
                    marginBottom: "var(--space-md)",
                    color: "var(--color-ink)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {ns}
                </h3>

                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
                  {groupedByNamespace[ns]!.map((row) => (
                    <div
                      key={`${row.namespace}:${row.key}`}
                      style={{
                        backgroundColor: "var(--color-canvas)",
                        border: "1px solid var(--color-hairline)",
                        borderRadius: "var(--radius-md)",
                        padding: "var(--space-sm)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "flex-start",
                          marginBottom: "var(--space-xs)",
                        }}
                      >
                        <div>
                          <div
                            className="t-body-sm"
                            style={{
                              color: "var(--color-ink)",
                              fontWeight: 600,
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {row.key}
                          </div>
                          <div className="t-caption" style={{ color: "var(--color-muted)" }}>
                            {row.source} • {new Date(row.updatedAt).toLocaleString()}
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteMemory(row.key, row.namespace)}
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
                      <div
                        style={{
                          backgroundColor: "var(--color-surface-inset)",
                          border: "1px solid var(--color-hairline)",
                          borderRadius: "var(--radius-md)",
                          padding: "var(--space-sm)",
                          fontSize: 12,
                          fontFamily: "var(--font-mono)",
                          color: "var(--color-body)",
                          overflowX: "auto",
                          maxHeight: 150,
                          overflowY: "auto",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {typeof row.value === "string"
                          ? row.value
                          : JSON.stringify(row.value, null, 2)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && selectedProjectId !== null && namespaces.length === 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: 200,
              color: "var(--color-muted)",
            }}
          >
            <span className="t-body-sm">No memory entries yet</span>
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
