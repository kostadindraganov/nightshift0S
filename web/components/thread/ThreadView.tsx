/**
 * ThreadView — chronological event bubbles for a task thread.
 * Grouped by round; each event shows actor, kind badge, and pretty-printed
 * JSON payload. Renders all events in seq order (server guarantees monotonic).
 */

import type { ThreadEvent } from "../../lib/types.ts";

interface Props {
  events: ThreadEvent[];
}

function kindColor(kind: ThreadEvent["kind"]): string {
  switch (kind) {
    case "verdict": return "var(--color-primary)";
    case "finding": return "var(--color-error)";
    case "rebuttal": return "var(--color-warning)";
    case "human": return "var(--color-accent-blue)";
    case "system": return "var(--color-muted)";
    default: return "var(--color-muted-soft)";
  }
}

function KindBadge({ kind }: { kind: ThreadEvent["kind"] }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: "var(--radius-pill)",
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "var(--font-sans)",
        background: kindColor(kind) + "22",
        color: kindColor(kind),
        border: `1px solid ${kindColor(kind)}44`,
        textTransform: "uppercase",
        letterSpacing: "0.5px",
      }}
    >
      {kind}
    </span>
  );
}

function EventBubble({ event }: { event: ThreadEvent }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.payloadJson);
  } catch {
    parsed = event.payloadJson;
  }

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
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)", flexWrap: "wrap" }}>
        <KindBadge kind={event.kind} />
        <span
          className="t-code"
          style={{ fontSize: 12, color: "var(--color-body-strong)" }}
        >
          {event.actor}
        </span>
        <span style={{ fontSize: 11, color: "var(--color-muted)", marginLeft: "auto" }}>
          seq {event.seq}
          {event.redacted && (
            <span
              style={{
                marginLeft: 6,
                color: "var(--color-warning)",
                fontWeight: 600,
              }}
            >
              [redacted]
            </span>
          )}
        </span>
      </div>

      <pre
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--color-body)",
          background: "var(--color-surface-soft)",
          border: "1px solid var(--color-hairline)",
          borderRadius: "var(--radius-sm)",
          padding: "var(--space-xs)",
          margin: 0,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {typeof parsed === "string"
          ? parsed
          : JSON.stringify(parsed, null, 2)}
      </pre>

      <div style={{ fontSize: 11, color: "var(--color-muted)" }}>
        {new Date(event.createdAt).toLocaleString()}
      </div>
    </div>
  );
}

export function ThreadView({ events }: Props) {
  if (events.length === 0) {
    return (
      <div style={{ color: "var(--color-muted)", fontSize: 14, fontFamily: "var(--font-sans)", padding: "var(--space-md)" }}>
        No thread events yet.
      </div>
    );
  }

  // Group by round
  const byRound = new Map<number, ThreadEvent[]>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!byRound.has(e.round)) byRound.set(e.round, []);
    byRound.get(e.round)!.push(e);
  }

  const rounds = [...byRound.keys()].sort((a, b) => a - b);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-lg)" }}>
      {rounds.map((round) => (
        <div key={round}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-xs)",
              marginBottom: "var(--space-sm)",
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                fontFamily: "var(--font-sans)",
                color: "var(--color-primary)",
                textTransform: "uppercase",
                letterSpacing: "1px",
              }}
            >
              Round {round}
            </span>
            <div style={{ flex: 1, height: 1, background: "var(--color-hairline)" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-xs)" }}>
            {byRound.get(round)!.map((e) => (
              <EventBubble key={e.id} event={e} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
