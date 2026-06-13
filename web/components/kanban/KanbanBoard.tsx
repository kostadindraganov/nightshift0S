// KanbanBoard — the full board for one project.
// Handles data loading, live SSE updates, dnd-kit drag-and-drop with
// transition-law enforcement, optimistic reordering, and toasts.
import { useState, useEffect, useCallback, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { Task, TaskState } from "./types.ts";
import {
  COLUMNS,
  STATE_TO_COLUMN,
  LEGAL_EDGES,
  SYSTEM_ONLY_EDGES,
  NEEDS_MERGE_SHA_EDGES,
  type ColumnId,
} from "./types.ts";
import { KanbanColumn } from "./KanbanColumn.tsx";
import { DraftColumn } from "./DraftColumn.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { Toast } from "./Toast.tsx";
import { useEventStream } from "../../lib/useEventStream.ts";
import { listTasks, transitionTask, updateTask, deleteTask } from "../../lib/api.ts";
import type { NightshiftEvent } from "../../lib/api.ts";

interface Props {
  projectId: number;
  onOpenTask?: (id: number) => void;
  /** Bump to force a task refetch (e.g. after creating a task elsewhere). */
  reloadSignal?: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; tasks: Task[] };

/** Sort tasks by priority asc then id asc within a column. */
function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) =>
    a.priority !== b.priority ? a.priority - b.priority : a.id - b.id,
  );
}

/** Group tasks into the 7 column buckets. */
function groupTasks(tasks: Task[]): Record<ColumnId, Task[]> {
  const groups = Object.fromEntries(
    COLUMNS.map((c) => [c.id, [] as Task[]]),
  ) as Record<ColumnId, Task[]>;
  for (const t of sortTasks(tasks)) {
    const col = STATE_TO_COLUMN[t.state];
    groups[col].push(t);
  }
  return groups;
}

/** Find which column an over-id belongs to. */
function resolveColumn(
  overId: string | number,
  tasks: Task[],
): ColumnId | null {
  if (typeof overId === "string" && COLUMNS.some((c) => c.id === overId)) {
    return overId as ColumnId;
  }
  const hit = tasks.find((t) => t.id === overId);
  return hit ? STATE_TO_COLUMN[hit.state] : null;
}

function liveIndicator(connected: boolean) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 12,
        fontWeight: 500,
        color: connected ? "var(--color-success)" : "var(--color-muted)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: connected ? "var(--color-success)" : "var(--color-muted-soft)",
          animation: connected ? "pulse-dot 2s ease-in-out infinite" : undefined,
          flexShrink: 0,
        }}
      />
      {connected ? "Live" : "Connecting…"}
    </span>
  );
}

export function KanbanBoard({ projectId, onOpenTask, reloadSignal }: Props) {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null);

  // Ref so drag handlers can read latest task list synchronously.
  const loadStateRef = useRef(loadState);
  useEffect(() => {
    loadStateRef.current = loadState;
  }, [loadState]);

  // Debounce ref for SSE-triggered refetch.
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const tasks = await listTasks({ project_id: projectId });
      setLoadState({ kind: "ready", tasks });
    } catch (e) {
      setLoadState({
        kind: "error",
        message: e instanceof Error ? e.message : "Failed to load tasks",
      });
    }
  }, [projectId]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks, reloadSignal]);

  // Delete a task (only parked states are deletable; server enforces). No SSE
  // event is emitted for deletes, so refetch explicitly.
  const handleDelete = useCallback(
    async (taskId: number) => {
      try {
        await deleteTask(taskId);
        await loadTasks();
      } catch (e) {
        setToastMsg(
          e instanceof Error ? e.message : `Failed to delete task #${taskId}`,
        );
      }
    },
    [loadTasks],
  );

  // SSE handler — debounced refetch on any task-related event.
  const handleEvent = useCallback(
    (evt: NightshiftEvent) => {
      const isTaskEvent =
        evt.kind.startsWith("task.") ||
        (evt.taskId !== null && evt.projectId === projectId);
      if (!isTaskEvent) return;
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = setTimeout(() => void loadTasks(), 150);
    },
    [projectId, loadTasks],
  );

  const { connected } = useEventStream(handleEvent);

  // DnD sensors — distance=6 so a click doesn't accidentally start a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // Custom collision strategy (same logic as reference implementation).
  const collisionStrategy = useCallback<CollisionDetection>((args) => {
    const pw = pointerWithin(args);
    if (pw.length > 0) {
      const cardHit = pw.find((c) => typeof c.id === "number");
      if (cardHit) return [cardHit];
      return pw;
    }
    const ri = rectIntersection(args);
    if (ri.length > 0) {
      const cardHit = ri.find((c) => typeof c.id === "number");
      if (cardHit) return [cardHit];
      return ri;
    }
    return closestCorners(args);
  }, []);

  // ── Drag handlers ───────────────────────────────────────────────────────

  const handleDragStart = useCallback((evt: DragStartEvent) => {
    const id = typeof evt.active.id === "number" ? evt.active.id : null;
    if (id !== null) {
      setActiveTaskId(id);
      setToastMsg(null);
    }
  }, []);

  // Optimistic visual: move card to destination column on DragOver.
  const handleDragOver = useCallback((evt: DragOverEvent) => {
    const { active, over } = evt;
    if (!over) return;
    const prev = loadStateRef.current;
    if (prev.kind !== "ready") return;
    const activeId = typeof active.id === "number" ? active.id : null;
    if (activeId === null) return;
    const activeTask = prev.tasks.find((t) => t.id === activeId);
    if (!activeTask) return;
    const destColId = resolveColumn(over.id, prev.tasks);
    if (!destColId) return;
    const destCol = COLUMNS.find((c) => c.id === destColId);
    if (!destCol) return;
    const currentColId = STATE_TO_COLUMN[activeTask.state];
    if (currentColId === destColId) return;

    // Optimistically update the state to the column's first state for visuals.
    const targetState = destCol.targetState ?? destCol.states[0];
    const moved: Task = { ...activeTask, state: targetState as TaskState };
    const without = prev.tasks.filter((t) => t.id !== activeId);
    setLoadState({ kind: "ready", tasks: [...without, moved] });
  }, []);

  const handleDragEnd = useCallback(
    async (evt: DragEndEvent) => {
      const { active, over } = evt;
      setActiveTaskId(null);
      if (!over) return;
      const activeId = typeof active.id === "number" ? active.id : null;
      if (activeId === null) return;

      const prev = loadStateRef.current;
      if (prev.kind !== "ready") return;

      const activeTask = prev.tasks.find((t) => t.id === activeId);
      if (!activeTask) return;

      const destColId = resolveColumn(over.id, prev.tasks);
      if (!destColId) return;

      const destCol = COLUMNS.find((c) => c.id === destColId);
      if (!destCol) return;

      const sourceColId = STATE_TO_COLUMN[activeTask.state];

      // ── Within-column reorder ─────────────────────────────────────────
      if (sourceColId === destColId) {
        if (typeof over.id !== "number") return;
        const grouped = groupTasks(prev.tasks);
        const col = grouped[sourceColId];
        const oldIdx = col.findIndex((t) => t.id === activeId);
        const newIdx = col.findIndex((t) => t.id === over.id);
        if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;

        const reordered = arrayMove(col, oldIdx, newIdx);
        const updated = reordered.map((t, i) => ({ ...t, priority: i }));
        const others = prev.tasks.filter(
          (t) => STATE_TO_COLUMN[t.state] !== sourceColId,
        );
        setLoadState({ kind: "ready", tasks: [...others, ...updated] });

        // PATCH priorities optimistically, revert on failure.
        try {
          await Promise.all(
            updated.map((t) => updateTask(t.id, { priority: t.priority })),
          );
        } catch {
          setLoadState({ kind: "ready", tasks: prev.tasks });
          setToastMsg("Failed to save order");
        }
        return;
      }

      // ── Cross-column transition ───────────────────────────────────────

      // Validate: column drop blocked?
      if (destCol.dropBlocked || destCol.targetState === null) {
        // Revert optimistic drag-over state.
        setLoadState({ kind: "ready", tasks: prev.tasks });
        setToastMsg(
          destCol.dropBlockReason ?? `Cannot drop into ${destCol.label}`,
        );
        return;
      }

      const fromState = activeTask.state;
      const toState = destCol.targetState;
      const edge = `${fromState}->${toState}` as const;

      // Legal edge check.
      if (!LEGAL_EDGES.has(edge)) {
        setLoadState({ kind: "ready", tasks: prev.tasks });
        setToastMsg(`${fromState}->${toState} not allowed`);
        return;
      }
      // System-only edge check.
      if (SYSTEM_ONLY_EDGES.has(edge)) {
        setLoadState({ kind: "ready", tasks: prev.tasks });
        setToastMsg(`${edge} is system-only`);
        return;
      }
      // Needs merge_sha check.
      if (NEEDS_MERGE_SHA_EDGES.has(edge)) {
        setLoadState({ kind: "ready", tasks: prev.tasks });
        setToastMsg(`${edge} requires merge_sha`);
        return;
      }

      // Call the API with the optimistic state already applied.
      try {
        const updated = await transitionTask(activeId, {
          to: toState,
          expected_from: fromState,
          actor: "ui",
        });
        // Replace the task with server-confirmed data.
        setLoadState((s) => {
          if (s.kind !== "ready") return s;
          return {
            kind: "ready",
            tasks: s.tasks.map((t) => (t.id === updated.id ? updated : t)),
          };
        });
      } catch (e) {
        // Revert and show error.
        setLoadState({ kind: "ready", tasks: prev.tasks });
        const msg =
          e instanceof Error ? e.message : `${fromState}->${toState} failed`;
        setToastMsg(msg);
      }
    },
    [],
  );

  const handleDragCancel = useCallback(() => {
    setActiveTaskId(null);
    // Re-fetch to undo any optimistic drag-over visuals.
    void loadTasks();
  }, [loadTasks]);

  // ── Render ──────────────────────────────────────────────────────────────

  if (loadState.kind === "loading") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "var(--color-muted)",
          fontFamily: "var(--font-sans)",
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
        Loading tasks…
      </div>
    );
  }

  if (loadState.kind === "error") {
    return (
      <div
        role="alert"
        style={{
          margin: "var(--space-lg)",
          padding: "var(--space-md)",
          border: "1px solid var(--color-error)",
          borderRadius: "var(--radius-md)",
          color: "var(--color-error)",
          fontSize: 13,
          fontFamily: "var(--font-sans)",
          background: "rgba(239,68,68,0.08)",
        }}
      >
        {loadState.message}
      </div>
    );
  }

  const grouped = groupTasks(loadState.tasks);
  const activeTask =
    activeTaskId !== null
      ? loadState.tasks.find((t) => t.id === activeTaskId) ?? null
      : null;

  return (
    <>
      {/* Live indicator */}
      <div
        style={{
          position: "absolute",
          top: "var(--space-sm)",
          right: "var(--space-md)",
          zIndex: 10,
        }}
      >
        {liveIndicator(connected)}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionStrategy}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            gap: "var(--space-md)",
            padding: "var(--space-md)",
            overflowX: "auto",
            overflowY: "hidden",
            height: "100%",
            alignItems: "flex-start",
          }}
        >
          {COLUMNS.map((col) =>
            col.id === "draft" ? (
              <DraftColumn
                key={col.id}
                col={col}
                tasks={grouped[col.id] ?? []}
                onTaskPromoted={() => void loadTasks()}
                onToast={setToastMsg}
                onOpenTask={onOpenTask}
                onDelete={handleDelete}
              />
            ) : (
              <KanbanColumn key={col.id} col={col} tasks={grouped[col.id] ?? []} onOpenTask={onOpenTask} onDelete={handleDelete} />
            )
          )}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeTask ? <TaskCard task={activeTask} isDragging /> : null}
        </DragOverlay>
      </DndContext>

      <Toast message={toastMsg} onDismiss={() => setToastMsg(null)} />
    </>
  );
}
