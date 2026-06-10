// State badge + semantic color mapping.
// Each TaskState gets a background/text color from the design-system tokens.
import type { TaskState } from "./types.ts";

interface BadgeStyle {
  background: string;
  color: string;
  border: string;
}

const BADGE_STYLES: Record<TaskState, BadgeStyle> = {
  draft: {
    background: "var(--color-surface-elevated)",
    color: "var(--color-muted)",
    border: "var(--color-hairline)",
  },
  backlog: {
    background: "var(--color-surface-elevated)",
    color: "var(--color-muted)",
    border: "var(--color-hairline)",
  },
  ready: {
    background: "rgba(59,130,246,0.12)",
    color: "var(--color-accent-blue)",
    border: "rgba(59,130,246,0.3)",
  },
  coding: {
    background: "rgba(250,255,105,0.1)",
    color: "var(--color-primary)",
    border: "rgba(250,255,105,0.3)",
  },
  review: {
    background: "rgba(245,158,11,0.12)",
    color: "var(--color-warning)",
    border: "rgba(245,158,11,0.3)",
  },
  approved: {
    background: "rgba(59,130,246,0.12)",
    color: "var(--color-accent-blue)",
    border: "rgba(59,130,246,0.3)",
  },
  merging: {
    background: "rgba(59,130,246,0.12)",
    color: "var(--color-accent-blue)",
    border: "rgba(59,130,246,0.3)",
  },
  done: {
    background: "rgba(34,197,94,0.12)",
    color: "var(--color-success)",
    border: "rgba(34,197,94,0.3)",
  },
  needs_human: {
    background: "rgba(239,68,68,0.12)",
    color: "var(--color-error)",
    border: "rgba(239,68,68,0.3)",
  },
  failed: {
    background: "rgba(239,68,68,0.12)",
    color: "var(--color-error)",
    border: "rgba(239,68,68,0.3)",
  },
  cancelled: {
    background: "rgba(239,68,68,0.12)",
    color: "var(--color-error)",
    border: "rgba(239,68,68,0.3)",
  },
};

export function StateBadge({ state }: { state: TaskState }) {
  const s = BADGE_STYLES[state];
  const isCoding = state === "coding";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px",
        borderRadius: "var(--radius-pill)",
        border: `1px solid ${s.border}`,
        background: s.background,
        color: s.color,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1.4,
        letterSpacing: "0.3px",
        fontFamily: "var(--font-sans)",
        whiteSpace: "nowrap",
      }}
    >
      {isCoding && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--color-primary)",
            flexShrink: 0,
            animation: "pulse-dot 1.4s ease-in-out infinite",
          }}
        />
      )}
      {state}
    </span>
  );
}
