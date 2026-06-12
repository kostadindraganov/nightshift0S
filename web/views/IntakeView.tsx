// IntakeView — the project bootstrap "paste a plan" intake (GATE 4).
// Pick (or create) a project, paste a freeform plan/description, and the
// planner expands it into a backlog of tasks via POST /projects/:id/bootstrap.
// On success it lists the created tasks and offers a jump to the board.
import { useState, useEffect } from "react";
import { listProjects, createProject, bootstrapProject, ApiError } from "../lib/api.ts";
import type { Project } from "../lib/types.ts";

interface IntakeViewProps {
  onNavigate: (v: "board" | "settings" | "intake") => void;
}

type Phase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "submitting" }
  | { kind: "done"; tasks: { id: number; title: string }[] };

export default function IntakeView({ onNavigate }: IntakeViewProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [projects, setProjects] = useState<Project[]>([]);
  // selectedId === "new" means "create a project inline".
  const [selectedId, setSelectedId] = useState<number | "new">("new");
  const [newName, setNewName] = useState("");
  const [newRepo, setNewRepo] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const ps = await listProjects();
        setProjects(ps);
        setSelectedId(ps[0]?.id ?? "new");
        setPhase({ kind: "ready" });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load projects");
        setPhase({ kind: "ready" });
      }
    })();
  }, []);

  async function resolveProjectId(): Promise<number> {
    if (selectedId !== "new") return selectedId;
    if (!newName.trim() || !newRepo.trim()) {
      throw new Error("New project needs a name and a repo URL");
    }
    const created = await createProject({
      name: newName.trim(),
      repo_url: newRepo.trim(),
    });
    return created.id;
  }

  async function handleSubmit() {
    setError(null);
    if (description.trim().length === 0) {
      setError("Paste a plan or project description first");
      return;
    }
    setPhase({ kind: "submitting" });
    try {
      const projectId = await resolveProjectId();
      const res = await bootstrapProject(projectId, description.trim());
      setPhase({ kind: "done", tasks: res.tasks });
    } catch (e) {
      // 422 bootstrap_failed → the planner output could not be parsed.
      const msg =
        e instanceof ApiError && e.code === "bootstrap_failed"
          ? `Planner could not produce a task list: ${e.message}`
          : e instanceof Error
            ? e.message
            : "Bootstrap failed";
      setError(msg);
      setPhase({ kind: "ready" });
    }
  }

  if (phase.kind === "loading") {
    return (
      <div style={center}>
        <span style={{ color: "var(--color-muted)", fontSize: 14 }}>Loading…</span>
      </div>
    );
  }

  if (phase.kind === "done") {
    return (
      <div style={{ ...scroll }}>
        <div style={card}>
          <div className="t-title-md" style={{ color: "var(--color-ink)" }}>
            Backlog created — {phase.tasks.length} task{phase.tasks.length === 1 ? "" : "s"}
          </div>
          <p className="t-body-sm" style={{ color: "var(--color-muted)", margin: 0 }}>
            The planner expanded your plan into these tasks. They start in the backlog.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {phase.tasks.map((t) => (
              <li
                key={t.id}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "baseline",
                  padding: "var(--space-xs) var(--space-sm)",
                  background: "var(--color-surface-card)",
                  border: "1px solid var(--color-hairline)",
                  borderRadius: "var(--radius-md)",
                }}
              >
                <span className="t-code" style={{ color: "var(--color-muted)", fontSize: 12 }}>
                  #{t.id}
                </span>
                <span className="t-body-sm" style={{ color: "var(--color-ink)" }}>{t.title}</span>
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: "var(--space-sm)" }}>
            <button className="btn-primary" type="button" onClick={() => onNavigate("board")}>
              Go to board
            </button>
            <button
              type="button"
              style={btnGhost}
              onClick={() => {
                setDescription("");
                setPhase({ kind: "ready" });
              }}
            >
              Plan another
            </button>
          </div>
        </div>
      </div>
    );
  }

  const submitting = phase.kind === "submitting";

  return (
    <div style={scroll}>
      <div style={card}>
        <div>
          <div className="t-title-md" style={{ color: "var(--color-ink)" }}>
            Bootstrap a project
          </div>
          <p className="t-body-sm" style={{ color: "var(--color-muted)", margin: "4px 0 0" }}>
            Paste a plan, spec, or freeform description. The planner expands it into a backlog.
          </p>
        </div>

        {/* Project picker */}
        <label style={field}>
          <span style={label}>Project</span>
          <select
            value={String(selectedId)}
            onChange={(e) => setSelectedId(e.target.value === "new" ? "new" : Number(e.target.value))}
            disabled={submitting}
            style={input}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="new">+ New project…</option>
          </select>
        </label>

        {selectedId === "new" && (
          <div style={{ display: "flex", gap: "var(--space-sm)" }}>
            <label style={{ ...field, flex: 1 }}>
              <span style={label}>Name</span>
              <input
                style={input}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="my-service"
                disabled={submitting}
              />
            </label>
            <label style={{ ...field, flex: 2 }}>
              <span style={label}>Repo URL</span>
              <input
                style={input}
                value={newRepo}
                onChange={(e) => setNewRepo(e.target.value)}
                placeholder="https://github.com/org/repo"
                disabled={submitting}
              />
            </label>
          </div>
        )}

        {/* Plan textarea */}
        <label style={field}>
          <span style={label}>Plan / description</span>
          <textarea
            style={{ ...input, minHeight: 220, resize: "vertical", fontFamily: "var(--font-mono)", lineHeight: 1.5 }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={"Build a REST API for a todo app:\n- user signup/login (JWT)\n- CRUD todos scoped to the user\n- Postgres + migrations\n- CI on PRs"}
            disabled={submitting}
          />
        </label>

        {error && (
          <div role="alert" className="t-body-sm" style={{ color: "var(--color-error)" }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
          <button className="btn-primary" type="button" onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? "Planning…" : "Generate backlog"}
          </button>
          <span className="t-body-sm" style={{ color: "var(--color-muted)" }}>
            Tasks land in the backlog — nothing runs until you move them.
          </span>
        </div>
      </div>
    </div>
  );
}

const scroll: React.CSSProperties = {
  height: "100%",
  overflow: "auto",
  display: "flex",
  justifyContent: "center",
  padding: "var(--space-xl) var(--space-md)",
  background: "var(--color-canvas)",
};

const center: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  fontFamily: "var(--font-sans)",
};

const card: React.CSSProperties = {
  width: "100%",
  maxWidth: 640,
  height: "fit-content",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-md)",
  background: "var(--color-surface-card)",
  border: "1px solid var(--color-hairline)",
  borderRadius: "var(--radius-lg)",
  padding: "var(--space-xl)",
};

const field: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const label: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-muted)",
  letterSpacing: 0.2,
};

const input: React.CSSProperties = {
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

const btnGhost: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "var(--space-xs) var(--space-md)",
  background: "transparent",
  color: "var(--color-ink)",
  border: "1px solid var(--color-hairline)",
  borderRadius: "var(--radius-md)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
