// KanbanColumn — a single vertical lane on the kanban board.
// Shows header (label + count), renders a droppable body with sorted cards.
import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Task } from "./types.ts";
import type { ColumnDef } from "./types.ts";
import { SortableTaskCard } from "./SortableTaskCard.tsx";

interface Props {
  col: ColumnDef;
  tasks: Task[];
  isOver?: boolean;
  onOpenTask?: (id: number) => void;
}

export function KanbanColumn({ col, tasks, onOpenTask }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: col.id });
  const ids = tasks.map((t) => t.id);

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 260,
        width: 280,
        flexShrink: 0,
        background: "var(--color-surface-soft)",
        border: `1px solid ${isOver ? "var(--color-hairline-strong)" : "var(--color-hairline)"}`,
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
        transition: "border-color 0.15s",
      }}
    >
      {/* Column header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--space-sm) var(--space-md)",
          borderBottom: "1px solid var(--color-hairline)",
          flexShrink: 0,
        }}
      >
        <span
          className="t-caption-uppercase"
          style={{ color: "var(--color-muted)" }}
        >
          {col.label}
        </span>
        <span
          style={{
            background: "var(--color-surface-elevated)",
            border: "1px solid var(--color-hairline)",
            borderRadius: "var(--radius-pill)",
            padding: "1px 8px",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            color: tasks.length > 0 ? "var(--color-primary)" : "var(--color-muted)",
            minWidth: 24,
            textAlign: "center",
          }}
        >
          {tasks.length}
        </span>
      </header>

      {/* Droppable card list */}
      <div
        ref={setNodeRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-xs)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-xs)",
          minHeight: 120,
          background: isOver ? "rgba(250,255,105,0.02)" : undefined,
          transition: "background 0.15s",
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <SortableTaskCard key={task.id} task={task} onOpenTask={onOpenTask} />
          ))}
        </SortableContext>

        {tasks.length === 0 && (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--color-muted-soft)",
              fontSize: 12,
              fontStyle: "italic",
              pointerEvents: "none",
              padding: "var(--space-md)",
              textAlign: "center",
            }}
          >
            No tasks
          </div>
        )}
      </div>
    </section>
  );
}
