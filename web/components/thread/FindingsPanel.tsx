/**
 * FindingsPanel — severity-colored rows of code review findings.
 * Shows severity badge, confidence, resolution state, file:line, and
 * a collapsible hunk context block. Critical/high are visually elevated.
 */

import { useState } from "react";
import type { Finding } from "../../lib/types.ts";

interface Props {
  findings: Finding[];
}

function severityColor(sev: Finding["severity"]): string {
  switch (sev) {
    case "critical":
    case "high":
      return "var(--color-error)";
    case "medium":
      return "var(--color-warning)";
    default:
      return "var(--color-muted)";
  }
}

function resolutionBg(state: Finding["resolutionState"]): string {
  switch (state) {
    case "fixed": return "var(--color-success)";
    case "open": return "var(--color-error)";
    case "rebutted": return "var(--color-warning)";
    case "withdrawn": return "var(--color-muted)";
    case "accepted_risk": return "var(--color-accent-blue)";
  }
}

function FindingRow({ finding }: { finding: Finding }) {
  const [expanded, setExpanded] = useState(false);
  const sevColor = severityColor(finding.severity);

  return (
    <div
      style={{
        background: "var(--color-surface-card)",
        border: `1px solid ${sevColor}33`,
        borderLeft: `3px solid ${sevColor}`,
        borderRadius: "var(--radius-md)",
        padding: "var(--space-sm)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-xs)",
      }}
    >
      {/* Top row: severity + resolution + file */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)", flexWrap: "wrap" }}>
        <span
          style={{
            padding: "1px 6px",
            borderRadius: "var(--radius-pill)",
            fontSize: 11,
            fontWeight: 700,
            fontFamily: "var(--font-sans)",
            color: sevColor,
            background: sevColor + "22",
            border: `1px solid ${sevColor}44`,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}
        >
          {finding.severity}
        </span>

        <span
          style={{
            padding: "1px 6px",
            borderRadius: "var(--radius-pill)",
            fontSize: 11,
            fontWeight: 600,
            fontFamily: "var(--font-sans)",
            color: "var(--color-canvas)",
            background: resolutionBg(finding.resolutionState),
          }}
        >
          {finding.resolutionState}
        </span>

        <span
          style={{
            fontSize: 11,
            color: "var(--color-muted)",
            fontFamily: "var(--font-sans)",
          }}
        >
          {Math.round(finding.confidence * 100)}% conf
        </span>

        {finding.filePathNew && (
          <span
            className="t-code"
            style={{
              fontSize: 11,
              color: "var(--color-body-strong)",
              background: "var(--color-surface-elevated)",
              padding: "1px 5px",
              borderRadius: "var(--radius-xs)",
            }}
          >
            {finding.filePathNew}
            {finding.resolutionState === "open" || finding.resolutionState === "rebutted"
              ? ""
              : ""}
          </span>
        )}

        <span
          style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-muted)", fontFamily: "var(--font-mono)" }}
        >
          r{finding.round} #{finding.id}
        </span>
      </div>

      {/* Description */}
      <p style={{ fontSize: 13, color: "var(--color-body)", fontFamily: "var(--font-sans)", lineHeight: 1.5 }}>
        {finding.description}
      </p>

      {/* Suggestion */}
      {finding.suggestion && (
        <p style={{ fontSize: 12, color: "var(--color-muted)", fontFamily: "var(--font-sans)", fontStyle: "italic" }}>
          {finding.suggestion}
        </p>
      )}

      {/* Hunk context toggle */}
      {finding.hunkContext && (
        <div>
          <button
            onClick={() => setExpanded((e) => !e)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 11,
              color: "var(--color-accent-blue)",
              fontFamily: "var(--font-sans)",
              padding: 0,
            }}
          >
            {expanded ? "Hide" : "Show"} diff context
          </button>
          {expanded && (
            <pre
              style={{
                marginTop: "var(--space-xs)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--color-body)",
                background: "var(--color-surface-soft)",
                border: "1px solid var(--color-hairline)",
                borderRadius: "var(--radius-sm)",
                padding: "var(--space-xs)",
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {finding.hunkContext}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function FindingsPanel({ findings }: Props) {
  if (findings.length === 0) {
    return (
      <div style={{ color: "var(--color-muted)", fontSize: 14, fontFamily: "var(--font-sans)", padding: "var(--space-md)" }}>
        No findings yet.
      </div>
    );
  }

  const order: Finding["severity"][] = ["critical", "high", "medium", "low", "nit"];
  const sorted = [...findings].sort((a, b) => {
    const ai = order.indexOf(a.severity);
    const bi = order.indexOf(b.severity);
    return ai !== bi ? ai - bi : a.id - b.id;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-xs)" }}>
      {sorted.map((f) => (
        <FindingRow key={f.id} finding={f} />
      ))}
    </div>
  );
}
