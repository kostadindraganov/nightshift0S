/**
 * TranscriptView — merged global-events + thread_events timeline for a task.
 * Shows all events in server-guaranteed seq order.
 * source="event" → system event row; source="thread" → reviewer/coder message.
 */

import type { TranscriptEvent } from "../../lib/types.ts";

interface Props {
  events: TranscriptEvent[];
  loading?: boolean;
}

function sourceColor(source: TranscriptEvent["source"]): string {
  return source === "thread" ? "var(--color-primary)" : "var(--color-muted)";
}

function kindColor(kind: string): string {
  if (kind.startsWith("run.")) return "var(--color-accent-blue)";
  if (kind.startsWith("task.")) return "var(--color-accent-green)";
  if (kind.startsWith("thread.")) return "var(--color-primary)";
  if (kind.startsWith("finding.")) return "var(--color-error)";
  if (kind.startsWith("verdict")) return "var(--color-warning)";
  return "var(--color-muted)";
}

function SourceBadge({ source }: { source: TranscriptEvent["source"] }) {
  const color = sourceColor(source);
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 5px",
        borderRadius: "var(--radius-sm)",
        fontSize: 10,
        fontWeight: 700,
        fontFamily: "var(--font-sans)",
        background: color + "22",
        color,
        border: `1px solid ${color}44`,
        textTransform: "uppercase",
        letterSpacing: "0.5px",
        flexShrink: 0,
      }}
    >
      {source === "thread" ? "thread" : "system"}
    </span>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const color = kindColor(kind);
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: "var(--radius-pill)",
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "var(--font-mono)",
        background: color + "18",
        color,
        border: `1px solid ${color}33`,
        maxWidth: 200,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
      title={kind}
    >
      {kind}
    </span>
  );
}

function TranscriptRow({ event }: { event: TranscriptEvent }) {
  const payload = event.payload;
  const hasPayload = payload !== null && payload !== undefined &&
    !(typeof payload === "object" && Object.keys(payload as object).length === 0);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-xxs)",
        padding: "var(--space-xs) var(--space-sm)",
        background: "var(--color-surface-card)",
        border: "1px solid var(--color-hairline)",
        borderRadius: "var(--radius-md)",
        borderLeft: `3px solid ${sourceColor(event.source)}`,
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-xs)",
          flexWrap: "wrap",
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--color-muted)",
            flexShrink: 0,
            minWidth: 32,
          }}
        >
          #{event.seq}
        </span>
        <SourceBadge source={event.source} />
        <KindBadge kind={event.kind} />
        {event.actor && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--color-body-strong)",
              flexShrink: 0,
            }}
          >
            {event.actor}
          </span>
        )}
        {event.round != null && (
          <span style={{ fontSize: 11, color: "var(--color-muted)", flexShrink: 0 }}>
            round {event.round}
          </span>
        )}
        {event.runId != null && (
          <span style={{ fontSize: 11, color: "var(--color-muted)", flexShrink: 0 }}>
            run #{event.runId}
          </span>
        )}
        {event.redacted && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--color-warning)",
              flexShrink: 0,
            }}
          >
            [redacted]
          </span>
        )}
        <span
          style={{
            fontSize: 11,
            color: "var(--color-muted)",
            marginLeft: "auto",
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {new Date(event.ts).toLocaleTimeString()}
        </span>
      </div>

      {/* Payload */}
      {hasPayload && !event.redacted && (
        <pre
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--color-body)",
            background: "var(--color-surface-soft)",
            border: "1px solid var(--color-hairline)",
            borderRadius: "var(--radius-sm)",
            padding: "var(--space-xs)",
            margin: 0,
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 180,
            overflowY: "auto",
          }}
        >
          {typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function TranscriptView({ events, loading }: Props) {
  if (loading) {
    return (
      <div
        style={{
          color: "var(--color-muted)",
          fontSize: 13,
          fontFamily: "var(--font-sans)",
          padding: "var(--space-md)",
        }}
      >
        Loading transcript…
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div
        style={{
          color: "var(--color-muted)",
          fontSize: 13,
          fontFamily: "var(--font-sans)",
          padding: "var(--space-md)",
        }}
      >
        No events yet.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-xxs)" }}>
      {events.map((e) => (
        <TranscriptRow key={`${e.source}-${e.seq}`} event={e} />
      ))}
    </div>
  );
}
