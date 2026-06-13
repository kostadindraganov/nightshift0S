// Experiment view — hill-climbing iteration ledger and metric chart (Phase 6, §3.11).
// Loads experiment data by run ID and renders the progress visualization.

import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { ExperimentResponse, ExperimentLedgerEntry } from "../lib/types";

export default function ExperimentView() {
  const [runId, setRunId] = useState<string>("");
  const [direction, setDirection] = useState<"lower" | "higher">("lower");
  const [data, setData] = useState<ExperimentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLoad = async () => {
    if (!runId.trim()) {
      setError("Please enter a run ID");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const runNum = parseInt(runId, 10);
      if (isNaN(runNum)) {
        setError("Run ID must be a number");
        return;
      }
      const response = await api.getRunExperiment(runNum, direction);
      setData(response);
    } catch (err) {
      const message =
        err instanceof api.ApiError ? err.message : "Failed to load experiment data";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  // Format commit SHA to short form
  const shortSha = (sha: string | null): string => {
    return sha ? sha.substring(0, 7) : "—";
  };

  // Format timestamp
  const formatTime = (ts: string): string => {
    try {
      const date = new Date(ts);
      return date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return ts;
    }
  };

  // Render status pill
  const renderStatusPill = (status: string) => {
    let bgColor = "var(--color-muted)";
    let fgColor = "var(--color-canvas)";

    if (status === "keep") {
      bgColor = "var(--color-success)";
      fgColor = "var(--color-on-success)";
    } else if (status === "discard") {
      bgColor = "var(--color-muted)";
      fgColor = "var(--color-canvas)";
    } else if (status === "crash") {
      bgColor = "var(--color-accent-rose)";
      fgColor = "var(--color-canvas)";
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
          fontWeight: 600,
        }}
      >
        {status}
      </span>
    );
  };

  // Get color for bar chart by status
  const getBarColor = (status: string): string => {
    if (status === "keep") return "var(--color-success)";
    if (status === "discard") return "var(--color-muted)";
    if (status === "crash") return "var(--color-accent-rose)";
    return "var(--color-muted)";
  };

  // Calculate max metric value for chart scaling
  const maxMetricValue =
    data && data.series.length > 0
      ? Math.max(
          ...data.series
            .map((s) => s.metricValue)
            .filter((v): v is number => v !== null),
          1
        )
      : 1;

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
          Experiments
        </h1>
        <p className="t-caption" style={{ color: "var(--color-muted)" }}>
          Hill-climbing iteration ledger per experiment run.
        </p>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-xl)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-lg)",
        }}
      >
        {/* Input Controls */}
        <div
          style={{
            display: "flex",
            gap: "var(--space-md)",
            alignItems: "flex-end",
            flexWrap: "wrap",
          }}
        >
          <div>
            <label className="t-caption" style={{ color: "var(--color-muted)" }}>
              Run ID
            </label>
            <input
              type="number"
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              placeholder="e.g. 42"
              style={{
                display: "block",
                marginTop: "var(--space-xs)",
                padding: "var(--space-sm)",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-hairline)",
                backgroundColor: "var(--color-surface-card)",
                color: "var(--color-body)",
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                minWidth: 120,
              }}
            />
          </div>

          <div>
            <label className="t-caption" style={{ color: "var(--color-muted)" }}>
              Direction
            </label>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as "lower" | "higher")}
              style={{
                display: "block",
                marginTop: "var(--space-xs)",
                padding: "var(--space-sm)",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-hairline)",
                backgroundColor: "var(--color-surface-card)",
                color: "var(--color-body)",
                fontFamily: "var(--font-sans)",
                fontSize: 14,
              }}
            >
              <option value="lower">Lower is better</option>
              <option value="higher">Higher is better</option>
            </select>
          </div>

          <button
            onClick={handleLoad}
            disabled={loading}
            style={{
              padding: "var(--space-sm) var(--space-md)",
              backgroundColor: loading ? "var(--color-muted)" : "var(--color-primary)",
              color: loading ? "var(--color-canvas)" : "var(--color-on-primary)",
              border: "none",
              borderRadius: "var(--radius-md)",
              fontSize: 14,
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "Loading…" : "Load"}
          </button>
        </div>

        {/* Error state */}
        {error && (
          <div
            style={{
              backgroundColor: "rgba(239, 68, 68, 0.1)",
              border: "1px solid var(--color-accent-rose)",
              borderRadius: "var(--radius-lg)",
              padding: "var(--space-md)",
            }}
          >
            <p
              className="t-body-sm"
              style={{
                color: "var(--color-accent-rose)",
                margin: 0,
              }}
            >
              {error}
            </p>
          </div>
        )}

        {/* Data view */}
        {!loading && !error && data && (
          <>
            {/* BEST card */}
            {data.best ? (
              <div
                style={{
                  backgroundColor: "var(--color-surface-card)",
                  border: "1px solid var(--color-hairline)",
                  borderRadius: "var(--radius-lg)",
                  padding: "var(--space-md)",
                }}
              >
                <p
                  className="t-caption"
                  style={{
                    color: "var(--color-muted)",
                    margin: 0,
                    marginBottom: "var(--space-sm)",
                  }}
                >
                  Best Iteration
                </p>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                    gap: "var(--space-md)",
                  }}
                >
                  <div>
                    <p
                      className="t-body-sm"
                      style={{
                        color: "var(--color-muted)",
                        margin: 0,
                        marginBottom: "var(--space-xs)",
                      }}
                    >
                      Iteration
                    </p>
                    <p
                      className="t-title-md"
                      style={{ color: "var(--color-ink)", margin: 0 }}
                    >
                      {data.best.iteration}
                    </p>
                  </div>
                  <div>
                    <p
                      className="t-body-sm"
                      style={{
                        color: "var(--color-muted)",
                        margin: 0,
                        marginBottom: "var(--space-xs)",
                      }}
                    >
                      {data.best.metricName}
                    </p>
                    <p
                      className="t-title-md"
                      style={{ color: "var(--color-ink)", margin: 0 }}
                    >
                      {data.best.metricValue !== null
                        ? data.best.metricValue.toFixed(4)
                        : "—"}
                    </p>
                  </div>
                  <div>
                    <p
                      className="t-body-sm"
                      style={{
                        color: "var(--color-muted)",
                        margin: 0,
                        marginBottom: "var(--space-xs)",
                      }}
                    >
                      Commit
                    </p>
                    <p
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 13,
                        color: "var(--color-body)",
                        margin: 0,
                      }}
                    >
                      {shortSha(data.best.commitSha)}
                    </p>
                  </div>
                  <div>
                    <p
                      className="t-body-sm"
                      style={{
                        color: "var(--color-muted)",
                        margin: 0,
                        marginBottom: "var(--space-xs)",
                      }}
                    >
                      Status
                    </p>
                    {renderStatusPill(data.best.status)}
                  </div>
                </div>
              </div>
            ) : (
              <div
                style={{
                  backgroundColor: "var(--color-surface-card)",
                  border: "1px solid var(--color-hairline)",
                  borderRadius: "var(--radius-lg)",
                  padding: "var(--space-md)",
                }}
              >
                <p
                  className="t-body-sm"
                  style={{ color: "var(--color-muted)", margin: 0 }}
                >
                  No best iteration yet.
                </p>
              </div>
            )}

            {/* METRIC CHART */}
            {data.series && data.series.length > 0 && (
              <div
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
                    color: "var(--color-ink)",
                    margin: 0,
                    marginBottom: "var(--space-md)",
                  }}
                >
                  Metric Progress
                </h2>
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-end",
                    gap: "var(--space-xs)",
                    height: 180,
                    overflow: "auto",
                  }}
                >
                  {data.series.map((point, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: "var(--space-xs)",
                        flex: "0 0 auto",
                        minWidth: 30,
                      }}
                    >
                      <div
                        title={
                          point.metricValue !== null
                            ? `${point.metricValue.toFixed(2)}`
                            : "null"
                        }
                        style={{
                          width: 24,
                          height:
                            point.metricValue !== null
                              ? Math.max(
                                  (point.metricValue / maxMetricValue) * 150,
                                  8
                                )
                              : 8,
                          backgroundColor: getBarColor(point.status),
                          borderRadius: "var(--radius-sm)",
                          transition: "background-color 0.2s",
                        }}
                      />
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--color-muted)",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {point.iteration}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* LEDGER TABLE */}
            {data.ledger && data.ledger.length > 0 && (
              <div
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
                    color: "var(--color-ink)",
                    margin: 0,
                    marginBottom: "var(--space-md)",
                  }}
                >
                  Iteration Ledger
                </h2>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 13,
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        borderBottom: "1px solid var(--color-hairline)",
                        backgroundColor: "var(--color-canvas)",
                      }}
                    >
                      <th
                        style={{
                          textAlign: "left",
                          padding: "var(--space-sm) var(--space-md)",
                          color: "var(--color-muted)",
                          fontWeight: 600,
                          fontSize: 12,
                        }}
                      >
                        Iteration
                      </th>
                      <th
                        style={{
                          textAlign: "left",
                          padding: "var(--space-sm) var(--space-md)",
                          color: "var(--color-muted)",
                          fontWeight: 600,
                          fontSize: 12,
                        }}
                      >
                        Status
                      </th>
                      <th
                        style={{
                          textAlign: "right",
                          padding: "var(--space-sm) var(--space-md)",
                          color: "var(--color-muted)",
                          fontWeight: 600,
                          fontSize: 12,
                        }}
                      >
                        Metric Value
                      </th>
                      <th
                        style={{
                          textAlign: "left",
                          padding: "var(--space-sm) var(--space-md)",
                          color: "var(--color-muted)",
                          fontWeight: 600,
                          fontSize: 12,
                        }}
                      >
                        Commit
                      </th>
                      <th
                        style={{
                          textAlign: "left",
                          padding: "var(--space-sm) var(--space-md)",
                          color: "var(--color-muted)",
                          fontWeight: 600,
                          fontSize: 12,
                        }}
                      >
                        Description
                      </th>
                      <th
                        style={{
                          textAlign: "left",
                          padding: "var(--space-sm) var(--space-md)",
                          color: "var(--color-muted)",
                          fontWeight: 600,
                          fontSize: 12,
                        }}
                      >
                        Created
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ledger.map((entry) => (
                      <tr
                        key={entry.id}
                        style={{
                          borderTop: "1px solid var(--color-hairline)",
                        }}
                      >
                        <td
                          style={{
                            padding: "var(--space-sm) var(--space-md)",
                            textAlign: "left",
                            color: "var(--color-body-strong)",
                          }}
                        >
                          {entry.iteration}
                        </td>
                        <td
                          style={{
                            padding: "var(--space-sm) var(--space-md)",
                            textAlign: "left",
                          }}
                        >
                          {renderStatusPill(entry.status)}
                        </td>
                        <td
                          style={{
                            padding: "var(--space-sm) var(--space-md)",
                            textAlign: "right",
                            color: "var(--color-body)",
                          }}
                        >
                          {entry.metricValue !== null
                            ? entry.metricValue.toFixed(4)
                            : "—"}
                        </td>
                        <td
                          style={{
                            padding: "var(--space-sm) var(--space-md)",
                            textAlign: "left",
                            color: "var(--color-body)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {shortSha(entry.commitSha)}
                        </td>
                        <td
                          style={{
                            padding: "var(--space-sm) var(--space-md)",
                            textAlign: "left",
                            color: "var(--color-body)",
                          }}
                        >
                          {entry.description || "—"}
                        </td>
                        <td
                          style={{
                            padding: "var(--space-sm) var(--space-md)",
                            textAlign: "left",
                            color: "var(--color-muted)",
                            fontSize: 12,
                          }}
                        >
                          {formatTime(entry.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Empty state */}
            {(!data.ledger || data.ledger.length === 0) && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: 200,
                  color: "var(--color-muted)",
                }}
              >
                <span className="t-body-sm">No experiment data for this run.</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
