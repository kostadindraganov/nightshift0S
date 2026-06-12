/**
 * TaskDetailView — full detail panel for a single task.
 * Loads task + thread + findings; subscribes to the SSE stream and refetches
 * on thread.appended / finding.updated / task.* events for this task.
 * For a task with a live (non-terminal) run, the sidebar mounts a read-only
 * xterm.js terminal attached to that run's tmux pane; otherwise it shows a
 * labelled placeholder (the empty/disconnected state).
 */

import { useState, useEffect, useCallback } from "react";
import * as api from "../lib/api.ts";
import { useEventStream } from "../lib/useEventStream.ts";
import type { Task, ThreadEvent, Finding } from "../lib/types.ts";
import { ThreadView } from "../components/thread/ThreadView.tsx";
import { FindingsPanel } from "../components/thread/FindingsPanel.tsx";
import { VerdictPanel } from "../components/thread/VerdictPanel.tsx";
import { TerminalView } from "../components/terminal/TerminalView.tsx";
import type { NightshiftEvent } from "../lib/api.ts";

// Run states with a still-live tmux pane worth attaching to (non-terminal).
const LIVE_RUN_STATES = new Set(["queued", "starting", "running", "finishing"]);

interface RunSummary {
  id: number;
  state: string;
  tmuxSession: string | null;
}

interface Props {
  taskId: number;
  onBack: () => void;
}

type Panel = "thread" | "findings" | "verdict";

export default function TaskDetailView({ taskId, onBack }: Props) {
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<Panel>("thread");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [liveRunId, setLiveRunId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const [t, th, fi, runs] = await Promise.all([
        api.getTask(taskId),
        api.getThread(taskId),
        api.getFindings(taskId),
        api.apiFetch<RunSummary[]>(`/runs?task_id=${taskId}`),
      ]);
      setTask(t);
      setEvents(th);
      setFindings(fi);
      // Newest run first; attach to the latest non-terminal run that has a
      // live tmux session. Anything else → null (placeholder is shown).
      const live = [...runs]
        .sort((a, b) => b.id - a.id)
        .find((r) => LIVE_RUN_STATES.has(r.state) && r.tmuxSession !== null);
      setLiveRunId(live ? live.id : null);
      setError(null);
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : "Failed to load task");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Subscribe to SSE; refetch when relevant events arrive for this task.
  const handleEvent = useCallback(
    (e: NightshiftEvent) => {
      if (e.taskId !== taskId) return;
      if (
        e.kind === "thread.appended" ||
        e.kind === "finding.updated" ||
        e.kind.startsWith("task.") ||
        e.kind.startsWith("run.")
      ) {
        void reload();
      }
    },
    [taskId, reload],
  );

  useEventStream(handleEvent);

  // Derive the latest verdict summary from thread events.
  const verdictEvents = [...events]
    .filter((e) => e.kind === "verdict")
    .sort((a, b) => b.seq - a.seq);
  const latestVerdict = verdictEvents[0] ?? null;
  let verdictSummary: string | null = null;
  let verdictOutcome: "approved" | "revise" | null = null;
  if (latestVerdict) {
    try {
      const p = JSON.parse(latestVerdict.payloadJson) as { summary?: string; verdict?: string };
      verdictSummary = p.summary ?? null;
      verdictOutcome = (p.verdict as "approved" | "revise") ?? null;
    } catch {
      // malformed payload — leave null
    }
  }

  async function handleReviewRound() {
    if (!task) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await api.triggerReviewRound(taskId);
      await reload();
    } catch (e) {
      setActionError(e instanceof api.ApiError ? e.message : "Review round failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleVerdict(decision: "resume_coding" | "force_merge" | "reject") {
    setActionLoading(true);
    setActionError(null);
    try {
      await api.postVerdict(taskId, { decision, actor: "human:ui" });
      await reload();
    } catch (e) {
      setActionError(e instanceof api.ApiError ? e.message : "Verdict failed");
    } finally {
      setActionLoading(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: "var(--space-xs) var(--space-md)",
    border: "none",
    borderBottom: active ? "2px solid var(--color-primary)" : "2px solid transparent",
    background: "none",
    color: active ? "var(--color-primary)" : "var(--color-muted)",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    letterSpacing: 0,
    transition: "color 0.15s, border-color 0.15s",
  });

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
          display: "flex",
          alignItems: "center",
          gap: "var(--space-md)",
          padding: "var(--space-sm) var(--space-xl)",
          borderBottom: "1px solid var(--color-hairline)",
          flexShrink: 0,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--color-muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 14,
            padding: "var(--space-xxs) var(--space-xs)",
            borderRadius: "var(--radius-sm)",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          ← Back
        </button>

        {task ? (
          <>
            <h1
              className="t-title-md"
              style={{ color: "var(--color-ink)", flex: 1, margin: 0 }}
            >
              {task.title}
            </h1>
            <span
              style={{
                padding: "2px 8px",
                borderRadius: "var(--radius-pill)",
                fontSize: 11,
                fontWeight: 700,
                fontFamily: "var(--font-sans)",
                background: "var(--color-surface-elevated)",
                color: "var(--color-primary)",
                border: "1px solid var(--color-hairline)",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              {task.state}
            </span>
            <span
              className="t-code"
              style={{ fontSize: 12, color: "var(--color-muted)" }}
            >
              #{task.id}
            </span>
          </>
        ) : (
          <span style={{ color: "var(--color-muted)", fontSize: 14 }}>
            {loading ? "Loading…" : `Task #${taskId}`}
          </span>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            margin: "var(--space-md) var(--space-xl) 0",
            padding: "var(--space-sm) var(--space-md)",
            backgroundColor: "rgba(239,68,68,0.1)",
            border: "1px solid var(--color-accent-rose)",
            borderRadius: "var(--radius-md)",
            color: "var(--color-accent-rose)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {actionError && (
        <div
          style={{
            margin: "var(--space-sm) var(--space-xl) 0",
            padding: "var(--space-xs) var(--space-md)",
            backgroundColor: "rgba(239,68,68,0.08)",
            border: "1px solid var(--color-accent-rose)",
            borderRadius: "var(--radius-md)",
            color: "var(--color-accent-rose)",
            fontSize: 12,
          }}
        >
          {actionError}
        </div>
      )}

      {!loading && task && (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Two-column layout: main content + sidebar */}
          <div
            style={{
              flex: 1,
              display: "flex",
              overflow: "hidden",
            }}
          >
            {/* Main content pane */}
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                borderRight: "1px solid var(--color-hairline)",
              }}
            >
              {/* Tabs */}
              <div
                style={{
                  display: "flex",
                  borderBottom: "1px solid var(--color-hairline)",
                  flexShrink: 0,
                  padding: "0 var(--space-xl)",
                }}
              >
                <button style={tabStyle(activePanel === "thread")} onClick={() => setActivePanel("thread")}>
                  Thread ({events.length})
                </button>
                <button style={tabStyle(activePanel === "findings")} onClick={() => setActivePanel("findings")}>
                  Findings ({findings.length})
                </button>
                <button style={tabStyle(activePanel === "verdict")} onClick={() => setActivePanel("verdict")}>
                  Actions
                </button>
              </div>

              {/* Tab content */}
              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "var(--space-lg) var(--space-xl)",
                }}
              >
                {activePanel === "thread" && <ThreadView events={events} />}
                {activePanel === "findings" && <FindingsPanel findings={findings} />}
                {activePanel === "verdict" && task && (
                  <VerdictPanel
                    task={task}
                    onVerdict={handleVerdict}
                    onReviewRound={handleReviewRound}
                    verdictSummary={verdictSummary}
                    verdictOutcome={verdictOutcome}
                    loading={actionLoading}
                  />
                )}
              </div>
            </div>

            {/* Sidebar: task metadata + terminal placeholder */}
            <div
              style={{
                width: 300,
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-md)",
                padding: "var(--space-lg) var(--space-md)",
                overflowY: "auto",
              }}
            >
              {/* Task metadata */}
              <div
                style={{
                  background: "var(--color-surface-card)",
                  border: "1px solid var(--color-hairline)",
                  borderRadius: "var(--radius-lg)",
                  padding: "var(--space-md)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-xs)",
                }}
              >
                <div className="t-caption-uppercase" style={{ color: "var(--color-muted)", marginBottom: "var(--space-xxs)" }}>
                  Task info
                </div>

                {([
                  ["Round", String(task.round)],
                  ["Risk tier", task.riskTier],
                  ["Category", task.category ?? "—"],
                  ["Branch", task.branch ?? "—"],
                  ["Base SHA", task.baseSha ? task.baseSha.slice(0, 8) : "—"],
                  ["Claimed by", task.claimedBy ?? "—"],
                ] as [string, string][]).map(([label, value]) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-xs)" }}>
                    <span style={{ fontSize: 12, color: "var(--color-muted)", fontFamily: "var(--font-sans)" }}>{label}</span>
                    <span
                      className="t-code"
                      style={{ fontSize: 12, color: "var(--color-body-strong)", textAlign: "right" }}
                    >
                      {value}
                    </span>
                  </div>
                ))}

                {task.description && (
                  <div style={{ marginTop: "var(--space-xs)", paddingTop: "var(--space-xs)", borderTop: "1px solid var(--color-hairline)" }}>
                    <p style={{ fontSize: 12, color: "var(--color-muted)", fontFamily: "var(--font-sans)", lineHeight: 1.5 }}>
                      {task.description}
                    </p>
                  </div>
                )}
              </div>

              {/* Live terminal: read-only xterm attach to the run's tmux pane
                  when a live run exists; otherwise the disconnected placeholder. */}
              {liveRunId !== null ? (
                <TerminalView key={liveRunId} runId={liveRunId} />
              ) : (
                <div
                  style={{
                    background: "var(--color-surface-card)",
                    border: "1px dashed var(--color-hairline-strong)",
                    borderRadius: "var(--radius-lg)",
                    padding: "var(--space-md)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-xs)",
                    minHeight: 160,
                    alignItems: "center",
                    justifyContent: "center",
                    textAlign: "center",
                  }}
                >
                  <span style={{ fontSize: 20 }}>⬛</span>
                  <p
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--color-muted)",
                      fontFamily: "var(--font-sans)",
                      lineHeight: 1.5,
                    }}
                  >
                    Live terminal
                  </p>
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--color-muted-soft)",
                      fontFamily: "var(--font-sans)",
                      lineHeight: 1.5,
                    }}
                  >
                    No live run to attach to
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-muted)",
            fontSize: 14,
            gap: "var(--space-xs)",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--color-primary)",
              animation: "pulse-dot 1s ease-in-out infinite",
              display: "inline-block",
            }}
          />
          Loading…
        </div>
      )}
    </div>
  );
}
