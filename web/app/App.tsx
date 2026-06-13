// Root application component.
// Handles the token gate (unauthenticated state) and top-level view routing.
// The connected flag from useEventStream is threaded down to AppShell so the
// live indicator always reflects the SSE connection status.
import { useState } from "react";
import { getToken, setToken } from "../lib/api.ts";
import { useEventStream } from "../lib/useEventStream.ts";
import AppShell from "./AppShell.tsx";
import BoardView from "../views/BoardView.tsx";
import SettingsView from "../views/SettingsView.tsx";
import IntakeView from "../views/IntakeView.tsx";
import RoutinesView from "../views/RoutinesView.tsx";
import AnalyticsView from "../views/AnalyticsView.tsx";
import MemoryView from "../views/MemoryView.tsx";
import ExperimentView from "../views/ExperimentView.tsx";
import TaskDetailView from "../views/TaskDetailView.tsx";

// ── Token gate ────────────────────────────────────────────────
function TokenGate() {
  const [draft, setDraft] = useState("");

  function handleConnect() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setToken(trimmed);
    window.location.reload();
  }

  return (
    <div className="token-gate-overlay">
      <div className="token-gate-card">
        <p className="token-gate-title">Connect to Nightshift</p>
        <p className="token-gate-helper">
          Enter your API token. This is the value of{" "}
          <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
            NIGHTSHIFT_API_TOKEN
          </code>{" "}
          set on the server.
        </p>
        <input
          className="token-gate-input"
          type="password"
          placeholder="nightshift_..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleConnect();
          }}
          autoFocus
          aria-label="API token"
        />
        <button
          className="btn-primary"
          type="button"
          onClick={handleConnect}
          disabled={!draft.trim()}
        >
          Connect
        </button>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState<
    "board" | "intake" | "routines" | "analytics" | "memory" | "experiments" | "settings"
  >("board");
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);

  // Subscribe to the event stream at the top level purely to drive the
  // connection indicator in AppShell.  Views may subscribe independently.
  const { connected } = useEventStream(() => {
    // no-op: App itself doesn't process events
  });

  if (!getToken()) {
    return <TokenGate />;
  }

  // Task detail view overlays the current view when a task is selected.
  if (selectedTaskId !== null) {
    return (
      <AppShell view={view} onNavigate={setView} connected={connected}>
        <TaskDetailView
          taskId={selectedTaskId}
          onBack={() => setSelectedTaskId(null)}
        />
      </AppShell>
    );
  }

  return (
    <AppShell view={view} onNavigate={setView} connected={connected}>
      {view === "board" ? (
        <BoardView onOpenTask={setSelectedTaskId} />
      ) : view === "intake" ? (
        <IntakeView onNavigate={setView} />
      ) : view === "routines" ? (
        <RoutinesView />
      ) : view === "analytics" ? (
        <AnalyticsView />
      ) : view === "memory" ? (
        <MemoryView />
      ) : view === "experiments" ? (
        <ExperimentView />
      ) : (
        <SettingsView />
      )}
    </AppShell>
  );
}
