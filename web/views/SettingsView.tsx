// Settings view — read-only display of config entries grouped by section.
// Loads config from the API, handles loading/error states, renders as cards.

import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { ConfigEntry } from "../lib/types";

export default function SettingsView() {
  const [entries, setEntries] = useState<ConfigEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await api.getConfig();
        setEntries(data);
      } catch (err) {
        const message =
          err instanceof api.ApiError ? err.message : "Failed to load config";
        setError(message);
      } finally {
        setLoading(false);
      }
    };
    loadConfig();
  }, []);

  // Group entries by section
  const groupedBySection: Record<string, ConfigEntry[]> = {};
  if (entries) {
    for (const entry of entries) {
      if (!groupedBySection[entry.section]) {
        groupedBySection[entry.section] = [];
      }
      groupedBySection[entry.section]!.push(entry);
    }
  }

  const sections = Object.keys(groupedBySection).sort();

  // Render value based on type and secret flag
  const renderValue = (entry: ConfigEntry) => {
    if (entry.secret) {
      return (
        <span style={{ color: "var(--color-muted)", fontFamily: "var(--font-mono)" }}>
          ••••••••
        </span>
      );
    }

    const { value } = entry;
    if (typeof value === "boolean") {
      return (
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {value ? "true" : "false"}
        </span>
      );
    }
    if (typeof value === "number") {
      return (
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {value}
        </span>
      );
    }
    if (Array.isArray(value)) {
      return (
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {value.join(", ")}
        </span>
      );
    }
    if (typeof value === "object" && value !== null) {
      return (
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {JSON.stringify(value)}
        </span>
      );
    }
    return (
      <span style={{ fontFamily: "var(--font-mono)" }}>
        {String(value)}
      </span>
    );
  };

  // Render source badge
  const renderSourceBadge = (source: string) => {
    let bgColor = "var(--color-muted)";
    let fgColor = "var(--color-canvas)";
    let label = source;

    if (source === "file") {
      bgColor = "var(--color-accent-blue)";
      label = "file";
    } else if (source === "env") {
      bgColor = "var(--color-primary)";
      fgColor = "var(--color-on-primary)";
      label = "env";
    } else if (source === "default") {
      bgColor = "var(--color-muted)";
      label = "default";
    }

    return (
      <span
        style={{
          display: "inline-block",
          backgroundColor: bgColor,
          color: fgColor,
          padding: "var(--space-xxs) var(--space-xs)",
          borderRadius: "var(--radius-pill)",
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        {label}
      </span>
    );
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: "var(--color-canvas)",
        color: "var(--color-body)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "var(--space-xl) var(--space-xl) var(--space-md) var(--space-xl)",
          borderBottom: "1px solid var(--color-hairline)",
        }}
      >
        <h1 className="t-title-lg" style={{ marginBottom: "var(--space-xs)" }}>
          Settings
        </h1>
        <p className="t-caption" style={{ color: "var(--color-muted)" }}>
          Read-only in V1 — config file + environment. Editable registry arrives in
          V1.5 (§3.12.19).
        </p>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-xl)",
        }}
      >
        {loading && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: 200,
              color: "var(--color-muted)",
            }}
          >
            <span className="t-body-sm">Loading config…</span>
          </div>
        )}

        {error && (
          <div
            style={{
              backgroundColor: "rgba(239, 68, 68, 0.1)",
              border: "1px solid var(--color-accent-rose)",
              borderRadius: "var(--radius-lg)",
              padding: "var(--space-md)",
              marginBottom: "var(--space-lg)",
            }}
          >
            <p
              className="t-body-sm"
              style={{
                color: "var(--color-accent-rose)",
              }}
            >
              {error}
            </p>
          </div>
        )}

        {!loading && !error && entries && sections.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(600px, 1fr))",
              gap: "var(--space-lg)",
            }}
          >
            {sections.map((section) => (
              <div
                key={section}
                style={{
                  backgroundColor: "var(--color-surface-card)",
                  border: "1px solid var(--color-hairline)",
                  borderRadius: "var(--radius-lg)",
                  padding: "var(--space-md)",
                }}
              >
                <h2
                  className="t-title-md"
                  style={{
                    marginBottom: "var(--space-md)",
                    color: "var(--color-ink)",
                  }}
                >
                  {section}
                </h2>

                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 14,
                  }}
                >
                  <tbody>
                    {groupedBySection[section]!.map((entry, idx) => (
                      <tr
                        key={`${section}-${entry.key}-${idx}`}
                        style={{
                          borderTop:
                            idx === 0
                              ? "none"
                              : "1px solid var(--color-hairline)",
                        }}
                      >
                        <td
                          style={{
                            paddingTop: "var(--space-sm)",
                            paddingBottom: "var(--space-sm)",
                            paddingRight: "var(--space-md)",
                            textAlign: "left",
                            verticalAlign: "top",
                            color: "var(--color-body)",
                          }}
                        >
                          <span
                            className="t-body-sm"
                            style={{
                              fontFamily: "var(--font-mono)",
                              color: "var(--color-body-strong)",
                            }}
                          >
                            {entry.key}
                          </span>
                        </td>
                        <td
                          style={{
                            paddingTop: "var(--space-sm)",
                            paddingBottom: "var(--space-sm)",
                            paddingRight: "var(--space-md)",
                            textAlign: "left",
                            verticalAlign: "top",
                            maxWidth: 300,
                            wordBreak: "break-word",
                            color: "var(--color-body)",
                          }}
                        >
                          {renderValue(entry)}
                        </td>
                        <td
                          style={{
                            paddingTop: "var(--space-sm)",
                            paddingBottom: "var(--space-sm)",
                            textAlign: "right",
                            verticalAlign: "top",
                          }}
                        >
                          {renderSourceBadge(entry.source)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}

        {!loading && !error && entries && sections.length === 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: 200,
              color: "var(--color-muted)",
            }}
          >
            <span className="t-body-sm">No config entries</span>
          </div>
        )}
      </div>
    </div>
  );
}
