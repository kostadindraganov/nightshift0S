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
  | { kind: "ready"; project: Project };

export default function BoardView({ onOpenTask }: BoardViewProps) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    void (async () => {
      try {
        const projects = await listProjects();
        const first = projects[0];
        if (first) {
          setState({ kind: "ready", project: first });
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
      setState({ kind: "ready", project });
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
        }}
      >
        <span className="t-title-sm" style={{ color: "var(--color-ink)" }}>
          {state.project.name}
        </span>
        <span
          className="t-code"
          style={{ color: "var(--color-muted)", fontSize: 12 }}
        >
          {state.project.repoUrl}
        </span>
      </div>

      {/* Kanban board takes remaining height */}
      <div style={{ height: "calc(100% - 49px)", overflow: "hidden" }}>
        <KanbanBoard projectId={state.project.id} onOpenTask={onOpenTask} />
      </div>
    </div>
  );
}

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
