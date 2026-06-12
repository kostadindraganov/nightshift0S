/**
 * VerdictPanel — review-action controls for a task.
 * Shows the latest verdict summary extracted from the thread, a "Run review
 * round" button (enabled when state=review), and break-glass human-verdict
 * buttons (enabled only when state=needs_human). Force-merge requires a
 * browser confirm dialog.
 */

import type { Task } from "../../lib/types.ts";

interface Props {
  task: Task;
  onVerdict: (decision: "resume_coding" | "force_merge" | "reject") => void;
  onReviewRound: () => void;
  /** Latest verdict summary text from the thread, if any. */
  verdictSummary?: string | null;
  verdictOutcome?: "approved" | "revise" | null;
  loading?: boolean;
}

const btnBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--space-xs) var(--space-md)",
  border: "none",
  borderRadius: "var(--radius-md)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  letterSpacing: 0,
  transition: "opacity 0.15s",
};

export function VerdictPanel({
  task,
  onVerdict,
  onReviewRound,
  verdictSummary,
  verdictOutcome,
  loading = false,
}: Props) {
  const canReview = task.state === "review";
  const isNeedsHuman = task.state === "needs_human";

  function handleForceMerge() {
    if (!window.confirm("Force-merge: bypass all review gates and move to merging. Continue?")) return;
    onVerdict("force_merge");
  }

  return (
    <div
      style={{
        background: "var(--color-surface-card)",
        border: "1px solid var(--color-hairline)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-md)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-md)",
      }}
    >
      <div className="t-title-sm" style={{ color: "var(--color-ink)" }}>
        Review controls
      </div>

      {/* Latest verdict summary */}
      {verdictSummary && (
        <div
          style={{
            background: "var(--color-surface-soft)",
            border: `1px solid ${verdictOutcome === "approved" ? "var(--color-success)" : verdictOutcome === "revise" ? "var(--color-warning)" : "var(--color-hairline)"}`,
            borderRadius: "var(--radius-sm)",
            padding: "var(--space-xs) var(--space-sm)",
          }}
        >
          {verdictOutcome && (
            <span
              style={{
                display: "inline-block",
                marginBottom: 4,
                padding: "1px 6px",
                borderRadius: "var(--radius-pill)",
                fontSize: 11,
                fontWeight: 700,
                fontFamily: "var(--font-sans)",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
                color: verdictOutcome === "approved" ? "var(--color-success)" : "var(--color-warning)",
                background: verdictOutcome === "approved" ? "rgba(34,197,94,0.15)" : "rgba(245,158,11,0.15)",
              }}
            >
              {verdictOutcome}
            </span>
          )}
          <p style={{ fontSize: 13, color: "var(--color-body)", fontFamily: "var(--font-sans)", lineHeight: 1.5 }}>
            {verdictSummary}
          </p>
        </div>
      )}

      {/* Run review round */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-xs)" }}>
        <button
          disabled={!canReview || loading}
          onClick={onReviewRound}
          style={{
            ...btnBase,
            background: canReview ? "var(--color-primary)" : "var(--color-primary-disabled)",
            color: canReview ? "var(--color-on-primary)" : "var(--color-muted)",
            opacity: canReview && !loading ? 1 : 0.5,
            cursor: canReview && !loading ? "pointer" : "not-allowed",
          }}
          title={canReview ? "Trigger a reviewer LLM pass on the current diff" : `Task is in '${task.state}' state — must be 'review'`}
        >
          {loading ? "Running…" : "Run review round"}
        </button>
        {!canReview && (
          <p style={{ fontSize: 11, color: "var(--color-muted)", fontFamily: "var(--font-sans)" }}>
            Requires state = review (current: {task.state})
          </p>
        )}
      </div>

      {/* Break-glass: human verdict buttons */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-xs)" }}>
        <p
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: isNeedsHuman ? "var(--color-warning)" : "var(--color-muted)",
            fontFamily: "var(--font-sans)",
            textTransform: "uppercase",
            letterSpacing: "0.8px",
          }}
        >
          Human override {!isNeedsHuman && `(task must be needs_human)`}
        </p>
        <div style={{ display: "flex", gap: "var(--space-xs)", flexWrap: "wrap" }}>
          <button
            disabled={!isNeedsHuman || loading}
            onClick={() => onVerdict("resume_coding")}
            style={{
              ...btnBase,
              background: isNeedsHuman ? "var(--color-accent-blue)" : "var(--color-surface-elevated)",
              color: isNeedsHuman ? "#fff" : "var(--color-muted)",
              opacity: isNeedsHuman && !loading ? 1 : 0.45,
              cursor: isNeedsHuman && !loading ? "pointer" : "not-allowed",
            }}
          >
            Resume coding
          </button>
          <button
            disabled={!isNeedsHuman || loading}
            onClick={handleForceMerge}
            style={{
              ...btnBase,
              background: isNeedsHuman ? "rgba(239,68,68,0.15)" : "var(--color-surface-elevated)",
              color: isNeedsHuman ? "var(--color-error)" : "var(--color-muted)",
              border: `1px solid ${isNeedsHuman ? "var(--color-error)" : "var(--color-hairline)"}`,
              opacity: isNeedsHuman && !loading ? 1 : 0.45,
              cursor: isNeedsHuman && !loading ? "pointer" : "not-allowed",
            }}
          >
            Force merge
          </button>
          <button
            disabled={!isNeedsHuman || loading}
            onClick={() => onVerdict("reject")}
            style={{
              ...btnBase,
              background: "var(--color-surface-elevated)",
              color: isNeedsHuman ? "var(--color-muted)" : "var(--color-muted-soft)",
              border: "1px solid var(--color-hairline)",
              opacity: isNeedsHuman && !loading ? 1 : 0.45,
              cursor: isNeedsHuman && !loading ? "pointer" : "not-allowed",
            }}
          >
            Reject / cancel
          </button>
        </div>
      </div>
    </div>
  );
}
