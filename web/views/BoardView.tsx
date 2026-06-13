// BoardView — root view for the kanban board.
// On mount, fetches projects; if none exist it seeds a demo project + tasks.
// Otherwise uses the first project and renders <KanbanBoard />.
import { useState, useEffect } from "react";
import {
  listProjects,
  createProject,
  createTask,
} from "../lib/api.ts";
import type { Project } from "../lib/types.ts";
import { KanbanBoard } from "../components/kanban/KanbanBoard.tsx";

interface BoardViewProps {
  onOpenTask?: (id: number) => void;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "seeding" }
  | { kind: "error"; message: string }
  | { kind: "ready"; projects: Project[]; selectedId: number };

export default function BoardView({ onOpenTask }: BoardViewProps) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  // Bumped after creating a task to force the board to refetch (create emits
  // no SSE event).
  const [reloadSignal, setReloadSignal] = useState(0);
  // Inline "add task" composer state.
  const [composerOpen, setComposerOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const projects = await listProjects();
        const first = projects[0];
        if (first) {
          setState({ kind: "ready", projects, selectedId: first.id });
        } else {
          setState({ kind: "empty" });
        }
      } catch (e) {
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "Failed to load projects",
        });
      }
    })();
  }, []);

  async function addTask(projectId: number) {
    const title = newTitle.trim();
    if (!title) return;
    setAdding(true);
    try {
      await createTask({ project_id: projectId, title });
      setNewTitle("");
      setComposerOpen(false);
      setReloadSignal((n) => n + 1);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to add task");
    } finally {
      setAdding(false);
    }
  }

  async function seedDemo() {
    setState({ kind: "seeding" });
    try {
      const project = await createProject({
        name: "Demo",
        repo_url: "https://github.com/example/demo",
        default_branch: "main",
      });
      await Promise.all([
        createTask({
          project_id: project.id,
          title: "Set up CI pipeline",
          description: "Configure GitHub Actions for lint, test, and build.",
          priority: 0,
          category: "infra",
          risk_tier: "low",
        }),
        createTask({
          project_id: project.id,
          title: "Design authentication flow",
          description: "OAuth2 + JWT session tokens, refresh on expiry.",
          priority: 1,
          category: "auth",
          risk_tier: "medium",
        }),
        createTask({
          project_id: project.id,
          title: "Build dashboard skeleton",
          description: "Responsive layout with sidebar navigation.",
          priority: 2,
          category: "frontend",
          risk_tier: "low",
        }),
        createTask({
          project_id: project.id,
          title: "Write integration tests",
          description: "Cover happy-path + error states for all API endpoints.",
          priority: 3,
          category: "testing",
          risk_tier: "low",
        }),
      ]);
      const projects = await listProjects();
      setState({
        kind: "ready",
        projects: projects.length > 0 ? projects : [project],
        selectedId: project.id,
      });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : "Failed to seed demo",
      });
    }
  }

  if (state.kind === "loading") {
    return (
      <div style={centerStyle}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: "var(--color-primary)",
            display: "inline-block",
            animation: "pulse-dot 1s ease-in-out infinite",
          }}
        />
        <span style={{ color: "var(--color-muted)", fontSize: 14, marginLeft: 10 }}>
          Loading…
        </span>
      </div>
    );
  }

  if (state.kind === "seeding") {
    return (
      <div style={centerStyle}>
        <span style={{ color: "var(--color-muted)", fontSize: 14 }}>
          Creating demo project…
        </span>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div
        role="alert"
        style={{
          ...centerStyle,
          flexDirection: "column",
          gap: 8,
          color: "var(--color-error)",
          fontSize: 13,
          fontFamily: "var(--font-sans)",
        }}
      >
        <span>Error: {state.message}</span>
        <button
          onClick={() => window.location.reload()}
          style={btnStyle}
        >
          Retry
        </button>
      </div>
    );
  }

  if (state.kind === "empty") {
    return (
      <div style={{ ...centerStyle, flexDirection: "column", gap: "var(--space-md)" }}>
        <div
          style={{
            background: "var(--color-surface-card)",
            border: "1px solid var(--color-hairline)",
            borderRadius: "var(--radius-lg)",
            padding: "var(--space-xl)",
            maxWidth: 380,
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-sm)",
            alignItems: "center",
          }}
        >
          <div className="t-title-md" style={{ color: "var(--color-ink)" }}>
            No projects yet
          </div>
          <p className="t-body-sm" style={{ color: "var(--color-muted)" }}>
            Create a demo project with sample tasks to explore the kanban board.
          </p>
          <button onClick={() => void seedDemo()} style={btnStyle}>
            Create demo project
          </button>
        </div>
      </div>
    );
  }

  // state.kind === "ready"
  const { projects, selectedId } = state;
  const selected = projects.find((p) => p.id === selectedId) ?? projects[0];

  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        overflow: "hidden",
        background: "var(--color-canvas)",
      }}
    >
      {/* Board header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-sm)",
          padding: "var(--space-sm) var(--space-md)",
          borderBottom: "1px solid var(--color-hairline)",
          flexShrink: 0,
          flexWrap: "wrap",
        }}
      >
        {/* Project selector */}
        <select
          aria-label="Select project"
          value={selectedId}
          onChange={(e) =>
            setState({
              kind: "ready",
              projects,
              selectedId: Number(e.target.value),
            })
          }
          style={{
            padding: "var(--space-xs) var(--space-sm)",
            background: "var(--color-surface-card)",
            color: "var(--color-ink)",
            border: "1px solid var(--color-hairline)",
            borderRadius: "var(--radius-md)",
            fontFamily: "var(--font-sans)",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span
          className="t-code"
          style={{ color: "var(--color-muted)", fontSize: 12 }}
        >
          {selected?.repoUrl}
        </span>

        <div style={{ flex: 1 }} />

        {/* Add-task composer */}
        {composerOpen ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void addTask(selectedId);
            }}
            style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)" }}
          >
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Task title…"
              disabled={adding}
              style={{
                padding: "var(--space-xs) var(--space-sm)",
                background: "var(--color-surface-card)",
                color: "var(--color-ink)",
                border: "1px solid var(--color-hairline)",
                borderRadius: "var(--radius-md)",
                fontFamily: "var(--font-sans)",
                fontSize: 14,
                minWidth: 220,
              }}
            />
            <button
              type="submit"
              disabled={adding || newTitle.trim() === ""}
              style={{ ...headerBtnStyle, opacity: adding || newTitle.trim() === "" ? 0.6 : 1 }}
            >
              {adding ? "Adding…" : "Add"}
            </button>
            <button
              type="button"
              onClick={() => {
                setComposerOpen(false);
                setNewTitle("");
              }}
              disabled={adding}
              style={headerBtnGhostStyle}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button onClick={() => setComposerOpen(true)} style={headerBtnStyle}>
            + Add task
          </button>
        )}
      </div>

      {/* Kanban board takes remaining height */}
      <div style={{ height: "calc(100% - 49px)", overflow: "hidden" }}>
        <KanbanBoard
          projectId={selectedId}
          onOpenTask={onOpenTask}
          reloadSignal={reloadSignal}
        />
      </div>
    </div>
  );
}

const headerBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--space-xs) var(--space-md)",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  border: "none",
  borderRadius: "var(--radius-md)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const headerBtnGhostStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--space-xs) var(--space-md)",
  background: "transparent",
  color: "var(--color-muted)",
  border: "1px solid var(--color-hairline)",
  borderRadius: "var(--radius-md)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const centerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  fontFamily: "var(--font-sans)",
};

const btnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--space-xs) var(--space-md)",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  border: "none",
  borderRadius: "var(--radius-md)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  letterSpacing: 0,
};
