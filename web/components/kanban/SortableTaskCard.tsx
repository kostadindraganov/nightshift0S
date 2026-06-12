// SortableTaskCard — wraps TaskCard with dnd-kit sortable handles.
// The wrapper div carries listeners so the inner card button stays clickable.
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "./types.ts";
import { TaskCard } from "./TaskCard.tsx";

interface Props {
  task: Task;
  onOpenTask?: (id: number) => void;
}

export function SortableTaskCard({ task, onOpenTask }: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { task } });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Keep placeholder space when dragging
    opacity: isDragging ? 0 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="touch-none"
      {...attributes}
      {...listeners}
    >
      <TaskCard task={task} isDragging={isDragging} onOpenTask={onOpenTask} />
    </div>
  );
}
