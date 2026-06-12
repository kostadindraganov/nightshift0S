// DraftColumn — the "To-Do" lane for tasks in state=draft.
// Renders as a KanbanColumn with an extra per-card "Promote" action that calls
// POST /tasks/:id/promote to move the task to backlog (draft→backlog edge).
// The column is not a drop target — drafts enter via the import flow or direct
// task creation, not by dragging.
import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "./types.ts";
import type { ColumnDef } from "./types.ts";
import { StateBadge } from "./stateBadge.tsx";
import { promoteDraft } from "../../lib/api.ts";

// ── DraftTaskCard ──────────────────────────────────────────────────────────

interface DraftCardProps {
	task: Task;
	onPromote: (taskId: number) => void;
	promoting: boolean;
	onOpenTask?: (id: number) => void;
}

function DraftTaskCard({ task, onPromote, promoting, onOpenTask }: DraftCardProps) {
	return (
		<div
			style={{
				background: "var(--color-surface-card)",
				border: "1px solid var(--color-hairline)",
				borderRadius: "var(--radius-md)",
				padding: "var(--space-sm)",
				display: "flex",
				flexDirection: "column",
				gap: "var(--space-xs)",
				cursor: "grab",
				transition: "background 0.1s, border-color 0.1s",
				userSelect: "none",
				opacity: promoting ? 0.6 : 1,
			}}
			className="task-card"
			onClick={(e) => {
				if (onOpenTask) {
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

			{/* Footer row: id + Promote button */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: "var(--space-xs)",
				}}
			>
				<span
					className="t-code"
					style={{ color: "var(--color-muted)", fontSize: 11 }}
				>
					#{task.id}
				</span>
				<button
					onClick={(e) => {
						e.stopPropagation();
						onPromote(task.id);
					}}
					disabled={promoting}
					style={{
						padding: "2px 8px",
						borderRadius: "var(--radius-pill)",
						background: promoting ? "var(--color-surface-elevated)" : "var(--color-primary)",
						color: promoting ? "var(--color-muted)" : "var(--color-on-primary)",
						border: "none",
						fontSize: 11,
						fontWeight: 600,
						fontFamily: "var(--font-sans)",
						cursor: promoting ? "default" : "pointer",
						transition: "background 0.15s",
						flexShrink: 0,
					}}
				>
					{promoting ? "Promoting…" : "Promote"}
				</button>
			</div>
		</div>
	);
}

// ── SortableDraftCard ──────────────────────────────────────────────────────

interface SortableDraftCardProps {
	task: Task;
	onPromote: (taskId: number) => void;
	promoting: boolean;
	onOpenTask?: (id: number) => void;
}

function SortableDraftCard({ task, onPromote, promoting, onOpenTask }: SortableDraftCardProps) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: task.id,
		data: { task },
	});

	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				opacity: isDragging ? 0 : 1,
			}}
			className="touch-none"
			{...attributes}
			{...listeners}
		>
			<DraftTaskCard
				task={task}
				onPromote={onPromote}
				promoting={promoting}
				onOpenTask={onOpenTask}
			/>
		</div>
	);
}

// ── DraftColumn ────────────────────────────────────────────────────────────

interface DraftColumnProps {
	col: ColumnDef;
	tasks: Task[];
	onTaskPromoted: (taskId: number) => void;
	onToast: (msg: string) => void;
	onOpenTask?: (id: number) => void;
}

export function DraftColumn({ col, tasks, onTaskPromoted, onToast, onOpenTask }: DraftColumnProps) {
	const { setNodeRef, isOver } = useDroppable({ id: col.id });
	const [promotingIds, setPromotingIds] = useState<Set<number>>(new Set());
	const ids = tasks.map((t) => t.id);

	async function handlePromote(taskId: number) {
		setPromotingIds((prev) => new Set(prev).add(taskId));
		try {
			await promoteDraft(taskId, { actor: "ui" });
			onTaskPromoted(taskId);
		} catch (e) {
			onToast(e instanceof Error ? e.message : `Failed to promote task #${taskId}`);
		} finally {
			setPromotingIds((prev) => {
				const next = new Set(prev);
				next.delete(taskId);
				return next;
			});
		}
	}

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
				<span className="t-caption-uppercase" style={{ color: "var(--color-muted)" }}>
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

			{/* Card list */}
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
				}}
			>
				<SortableContext items={ids} strategy={verticalListSortingStrategy}>
					{tasks.map((task) => (
						<SortableDraftCard
							key={task.id}
							task={task}
							onPromote={handlePromote}
							promoting={promotingIds.has(task.id)}
							onOpenTask={onOpenTask}
						/>
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
						No draft tasks
					</div>
				)}
			</div>
		</section>
	);
}
