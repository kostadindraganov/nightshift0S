// TaskCard — a single kanban task card with state badge, chips, and mono id.
// Used both in columns and as the DragOverlay ghost.
import type { Task } from "./types.ts";
import { StateBadge } from "./stateBadge.tsx";

interface TaskCardProps {
  task: Task;
  isDragging?: boolean;
  onOpenTask?: (id: number) => void;
}

function riskColor(tier: string): string {
  switch (tier) {
    case "high":
      return "var(--color-error)";
    case "medium":
      return "var(--color-warning)";
    default:
      return "var(--color-muted)";
  }
}

export function TaskCard({ task, isDragging = false, onOpenTask }: TaskCardProps) {
  return (
    <div
      style={{
        background: isDragging
          ? "var(--color-surface-elevated)"
          : "var(--color-surface-card)",
        border: `1px solid ${isDragging ? "var(--color-hairline-strong)" : "var(--color-hairline)"}`,
        borderRadius: "var(--radius-md)",
        padding: "var(--space-sm) var(--space-sm)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-xs)",
        cursor: isDragging ? "grabbing" : "grab",
        opacity: isDragging ? 0.85 : 1,
        transition: "background 0.1s, border-color 0.1s",
        userSelect: "none",
      }}
      className="task-card"
      onClick={(e) => {
        // Only fire if NOT a drag gesture (distance constraint handles it at
        // the DnD layer; we guard here too so a tap → open detail).
        if (!isDragging && onOpenTask) {
          e.stopPropagation();
          onOpenTask(task.id);
        }
      }}
    >
      {/* Title */}
      <div
        className="t-body-sm"
        style={{
          color: "var(--color-ink)",
          fontWeight: 500,
          lineClamp: 2,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical" as const,
        }}
      >
        {task.title}
      </div>

      {/* State badge */}
      <div>
        <StateBadge state={task.state} />
      </div>

      {/* Chips row */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          alignItems: "center",
        }}
      >
        {task.category && (
          <span
            style={{
              padding: "2px 6px",
              borderRadius: "var(--radius-pill)",
              background: "var(--color-surface-elevated)",
              border: "1px solid var(--color-hairline)",
              color: "var(--color-muted)",
              fontSize: 11,
              fontWeight: 500,
              fontFamily: "var(--font-sans)",
            }}
          >
            {task.category}
          </span>
        )}
        <span
          style={{
            padding: "2px 6px",
            borderRadius: "var(--radius-pill)",
            background: "var(--color-surface-elevated)",
            border: `1px solid ${riskColor(task.riskTier)}40`,
            color: riskColor(task.riskTier),
            fontSize: 11,
            fontWeight: 500,
            fontFamily: "var(--font-sans)",
          }}
        >
          {task.riskTier}
        </span>
      </div>

      {/* Task ID */}
      <div
        className="t-code"
        style={{
          color: "var(--color-muted)",
          fontSize: 11,
        }}
      >
        #{task.id}
      </div>
    </div>
  );
}
