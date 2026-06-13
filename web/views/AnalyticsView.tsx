// Analytics view — factory "mission control" dashboard (Phase 6, §3.7).
// Loads analytics from the API and renders overview, provider stats, and routing scores.

import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type {
  AnalyticsResponse,
  ProviderStat,
  FactoryOverview,
  RoutingScore,
} from "../lib/types";

export default function AnalyticsView() {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadAnalytics = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await api.getAnalytics();
        setData(response);
      } catch (err) {
        const message =
          err instanceof api.ApiError ? err.message : "Failed to load analytics";
        setError(message);
      } finally {
        setLoading(false);
      }
    };
    loadAnalytics();
  }, []);

  // Format USD currency
  const formatCost = (usd: number): string => {
    return `$${usd.toFixed(2)}`;
  };

  // Format duration milliseconds
  const formatDuration = (ms: number | null): string => {
    if (ms === null) return "—";
    const seconds = ms / 1000;
    return `${seconds.toFixed(1)}s`;
  };

  // Render success rate pill with color
  const renderSuccessRatePill = (rate: number) => {
    let bgColor = "var(--color-muted)";
    let fgColor = "var(--color-canvas)";

    if (rate >= 0.8) {
      bgColor = "var(--color-success)";
      fgColor = "var(--color-on-success)";
    } else if (rate >= 0.5) {
      bgColor = "var(--color-accent-amber)";
      fgColor = "var(--color-canvas)";
    } else {
      bgColor = "var(--color-accent-rose)";
      fgColor = "var(--color-canvas)";
    }

    const percentage = (rate * 100).toFixed(0);
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
        {percentage}%
      </span>
    );
  };

  // Render state breakdown chips
  const renderStateChips = (stateMap: Record<string, number>) => {
    const entries = Object.entries(stateMap).sort((a, b) => b[1] - a[1]);
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-xs)" }}>
        {entries.length > 0 ? (
          entries.map(([state, count]) => (
            <span
              key={state}
              style={{
                display: "inline-block",
                backgroundColor: "var(--color-muted)",
                color: "var(--color-canvas)",
                padding: "var(--space-xxs) var(--space-xs)",
                borderRadius: "var(--radius-pill)",
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              {state}: {count}
            </span>
          ))
        ) : (
          <span style={{ color: "var(--color-muted)", fontSize: 12 }}>—</span>
        )}
      </div>
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
          Analytics
        </h1>
        <p className="t-caption" style={{ color: "var(--color-muted)" }}>
          Evidence from completed runs — success, cost, latency, and routing scores.
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
            <span className="t-body-sm">Loading analytics…</span>
          </div>
        )}

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

        {!loading && !error && data && (
          <>
            {/* OVERVIEW */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
                gap: "var(--space-md)",
              }}
            >
              {/* Total Cost Card */}
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
                    marginBottom: "var(--space-xs)",
                  }}
                >
                  Total Cost
                </p>
                <p
                  className="t-title-lg"
                  style={{ color: "var(--color-ink)", margin: 0 }}
                >
                  {formatCost(data.overview.totalCostUsd)}
                </p>
              </div>

              {/* Active Runs Card */}
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
                    marginBottom: "var(--space-xs)",
                  }}
                >
                  Active Runs
                </p>
                <p
                  className="t-title-lg"
                  style={{ color: "var(--color-ink)", margin: 0 }}
                >
                  {data.overview.activeRuns}
                </p>
              </div>

              {/* Tasks by State Card */}
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
                    marginBottom: "var(--space-xs)",
                  }}
                >
                  Tasks by State
                </p>
                {renderStateChips(data.overview.tasksByState)}
              </div>

              {/* Runs by State Card */}
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
                    marginBottom: "var(--space-xs)",
                  }}
                >
                  Runs by State
                </p>
                {renderStateChips(data.overview.runsByState)}
              </div>
            </div>

            {/* PROVIDERS TABLE */}
            {data.providers && data.providers.length > 0 && (
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
                  Providers
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
                        Provider
                      </th>
                      <th
                        style={{
                          textAlign: "center",
                          padding: "var(--space-sm) var(--space-md)",
                          color: "var(--color-muted)",
                          fontWeight: 600,
                          fontSize: 12,
                        }}
                      >
                        Total
                      </th>
                      <th
                        style={{
                          textAlign: "center",
                          padding: "var(--space-sm) var(--space-md)",
                          color: "var(--color-muted)",
                          fontWeight: 600,
                          fontSize: 12,
                        }}
                      >
                        Success / Failed
                      </th>
                      <th
                        style={{
                          textAlign: "center",
                          padding: "var(--space-sm) var(--space-md)",
                          color: "var(--color-muted)",
                          fontWeight: 600,
                          fontSize: 12,
                        }}
                      >
                        Success Rate
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
                        Avg Duration
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
                        Total Cost
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
                        Top Exit Reasons
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.providers.map((stat) => (
                      <tr
                        key={stat.provider}
                        style={{
                          borderTop: "1px solid var(--color-hairline)",
                        }}
                      >
                        <td
                          style={{
                            padding: "var(--space-sm) var(--space-md)",
                            textAlign: "left",
                            color: "var(--color-body-strong)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {stat.provider}
                        </td>
                        <td
                          style={{
                            padding: "var(--space-sm) var(--space-md)",
                            textAlign: "center",
                            color: "var(--color-body)",
                          }}
                        >
                          {stat.total}
                        </td>
                        <td
                          style={{
                            padding: "var(--space-sm) var(--space-md)",
                            textAlign: "center",
                            color: "var(--color-body)",
                          }}
                        >
                          {stat.succeeded} / {stat.failed}
                        </td>
                        <td
                          style={{
                            padding: "var(--space-sm) var(--space-md)",
                            textAlign: "center",
                          }}
                        >
                          {renderSuccessRatePill(stat.successRate)}
                        </td>
                        <td
                          style={{
                            padding: "var(--space-sm) var(--space-md)",
                            textAlign: "right",
                            color: "var(--color-body)",
                          }}
                        >
                          {formatDuration(stat.avgDurationMs)}
                        </td>
                        <td
                          style={{
                            padding: "var(--space-sm) var(--space-md)",
                            textAlign: "right",
                            color: "var(--color-body)",
                          }}
                        >
                          {formatCost(stat.totalCostUsd)}
                        </td>
                        <td
                          style={{
                            padding: "var(--space-sm) var(--space-md)",
                            textAlign: "left",
                            color: "var(--color-body)",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              gap: "var(--space-xs)",
                              flexWrap: "wrap",
                            }}
                          >
                            {stat.topExitReasons && stat.topExitReasons.length > 0 ? (
                              stat.topExitReasons.slice(0, 2).map((reason) => (
                                <span
                                  key={reason.reason}
                                  style={{
                                    display: "inline-block",
                                    backgroundColor: "var(--color-muted)",
                                    color: "var(--color-canvas)",
                                    padding: "var(--space-xxs) var(--space-xs)",
                                    borderRadius: "var(--radius-pill)",
                                    fontSize: 11,
                                    fontWeight: 500,
                                  }}
                                >
                                  {reason.reason} ×{reason.count}
                                </span>
                              ))
                            ) : (
                              <span style={{ color: "var(--color-muted)", fontSize: 12 }}>
                                —
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* ROUTING SCORES */}
            {data.routing && data.routing.length > 0 && (
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
                  Routing Scores
                </h2>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-sm)",
                  }}
                >
                  {data.routing.map((score) => (
                    <div
                      key={score.provider}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--space-md)",
                        paddingTop: "var(--space-sm)",
                        paddingBottom: "var(--space-sm)",
                        borderTop: "1px solid var(--color-hairline)",
                      }}
                    >
                      <div style={{ minWidth: 120, flex: "0 0 auto" }}>
                        <span
                          className="t-body-sm"
                          style={{
                            fontFamily: "var(--font-mono)",
                            color: "var(--color-body-strong)",
                          }}
                        >
                          {score.provider}
                        </span>
                      </div>

                      <div style={{ flex: "0 0 auto" }}>
                        <span
                          style={{
                            display: "inline-block",
                            backgroundColor: "var(--color-primary)",
                            color: "var(--color-on-primary)",
                            padding: "var(--space-xxs) var(--space-sm)",
                            borderRadius: "var(--radius-pill)",
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {score.score.toFixed(2)}
                        </span>
                      </div>

                      <div
                        style={{
                          flex: 1,
                          fontSize: 13,
                          color: "var(--color-body)",
                        }}
                      >
                        {score.reason}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Empty state fallback */}
            {(!data.providers || data.providers.length === 0) &&
              (!data.routing || data.routing.length === 0) && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: 200,
                    color: "var(--color-muted)",
                  }}
                >
                  <span className="t-body-sm">No analytics data available yet.</span>
                </div>
              )}
          </>
        )}
      </div>
    </div>
  );
}
