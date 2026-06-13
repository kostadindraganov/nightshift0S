// Infra view — Workers, preview environments, and CLI status dashboard (Phase 7).
// Load infrastructure status from the API and render three read-only panels.

import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { WorkerRow, PreviewRow, CliStatusRow } from "../lib/types";

export default function InfraView() {
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null);
  const [previews, setPreviews] = useState<PreviewRow[] | null>(null);
  const [cliStatus, setCliStatus] = useState<CliStatusRow[] | null>(null);

  const [loadingWorkers, setLoadingWorkers] = useState(true);
  const [loadingPreviews, setLoadingPreviews] = useState(true);
  const [loadingCliStatus, setLoadingCliStatus] = useState(true);

  const [errorWorkers, setErrorWorkers] = useState<string | null>(null);
  const [errorPreviews, setErrorPreviews] = useState<string | null>(null);
  const [errorCliStatus, setErrorCliStatus] = useState<string | null>(null);

  // Load all three data sources on mount
  useEffect(() => {
    void (async () => {
      try {
        setLoadingWorkers(true);
        setErrorWorkers(null);
        const data = await api.getWorkers();
        setWorkers(data);
      } catch (err) {
        const msg = err instanceof api.ApiError ? err.message : "Failed to load workers";
        setErrorWorkers(msg);
      } finally {
        setLoadingWorkers(false);
      }
    })();

    void (async () => {
      try {
        setLoadingPreviews(true);
        setErrorPreviews(null);
        const data = await api.getPreviews();
        setPreviews(data);
      } catch (err) {
        const msg = err instanceof api.ApiError ? err.message : "Failed to load previews";
        setErrorPreviews(msg);
      } finally {
        setLoadingPreviews(false);
      }
    })();

    void (async () => {
      try {
        setLoadingCliStatus(true);
        setErrorCliStatus(null);
        const data = await api.getCliStatus();
        setCliStatus(data);
      } catch (err) {
        const msg = err instanceof api.ApiError ? err.message : "Failed to load CLI status";
        setErrorCliStatus(msg);
      } finally {
        setLoadingCliStatus(false);
      }
    })();
  }, []);

  // Format epoch milliseconds as local readable time
  const formatTimestamp = (ms: number): string => {
    return new Date(ms).toLocaleString();
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
          Infrastructure
        </h1>
        <p className="t-caption" style={{ color: "var(--color-muted)" }}>
          Workers, preview environments, and CLI binary status.
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
        {/* WORKERS SECTION */}
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
            Workers
          </h2>

          {loadingWorkers && (
            <div style={{ color: "var(--color-muted)" }}>
              <span className="t-body-sm">Loading workers…</span>
            </div>
          )}

          {errorWorkers && (
            <div
              style={{
                backgroundColor: "rgba(239, 68, 68, 0.1)",
                border: "1px solid var(--color-accent-rose)",
                borderRadius: "var(--radius-md)",
                padding: "var(--space-sm)",
              }}
            >
              <p
                className="t-body-sm"
                style={{
                  color: "var(--color-accent-rose)",
                  margin: 0,
                }}
              >
                {errorWorkers}
              </p>
            </div>
          )}

          {!loadingWorkers && !errorWorkers && workers && workers.length > 0 && (
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
                    ID
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
                    Host
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
                    Capacity
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
                    Status
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
                    Last Heartbeat
                  </th>
                </tr>
              </thead>
              <tbody>
                {workers.map((worker) => (
                  <tr
                    key={worker.id}
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
                      {worker.id}
                    </td>
                    <td
                      style={{
                        padding: "var(--space-sm) var(--space-md)",
                        textAlign: "left",
                        color: "var(--color-body)",
                      }}
                    >
                      {worker.host}
                    </td>
                    <td
                      style={{
                        padding: "var(--space-sm) var(--space-md)",
                        textAlign: "center",
                        color: "var(--color-body)",
                      }}
                    >
                      {worker.capacity}
                    </td>
                    <td
                      style={{
                        padding: "var(--space-sm) var(--space-md)",
                        textAlign: "center",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "var(--space-xs)",
                        }}
                      >
                        <div
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            backgroundColor: worker.alive
                              ? "var(--color-success)"
                              : "var(--color-accent-rose)",
                          }}
                        />
                        <span
                          style={{
                            fontSize: 13,
                            color: worker.alive ? "var(--color-success)" : "var(--color-accent-rose)",
                          }}
                        >
                          {worker.alive ? "live" : "offline"}
                        </span>
                      </div>
                    </td>
                    <td
                      style={{
                        padding: "var(--space-sm) var(--space-md)",
                        textAlign: "left",
                        color: "var(--color-body)",
                      }}
                    >
                      {formatTimestamp(worker.lastHeartbeat)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!loadingWorkers && !errorWorkers && (!workers || workers.length === 0) && (
            <div style={{ color: "var(--color-muted)" }}>
              <span className="t-body-sm">No workers yet.</span>
            </div>
          )}
        </div>

        {/* PREVIEWS SECTION */}
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
            Preview Environments
          </h2>

          {loadingPreviews && (
            <div style={{ color: "var(--color-muted)" }}>
              <span className="t-body-sm">Loading previews…</span>
            </div>
          )}

          {errorPreviews && (
            <div
              style={{
                backgroundColor: "rgba(239, 68, 68, 0.1)",
                border: "1px solid var(--color-accent-rose)",
                borderRadius: "var(--radius-md)",
                padding: "var(--space-sm)",
              }}
            >
              <p
                className="t-body-sm"
                style={{
                  color: "var(--color-accent-rose)",
                  margin: 0,
                }}
              >
                {errorPreviews}
              </p>
            </div>
          )}

          {!loadingPreviews && !errorPreviews && previews && previews.length > 0 && (
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
                    Run
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
                    URL
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
                      textAlign: "left",
                      padding: "var(--space-sm) var(--space-md)",
                      color: "var(--color-muted)",
                      fontWeight: 600,
                      fontSize: 12,
                    }}
                  >
                    Last Active
                  </th>
                </tr>
              </thead>
              <tbody>
                {previews.map((preview) => (
                  <tr
                    key={preview.runId}
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
                      {preview.runId}
                    </td>
                    <td
                      style={{
                        padding: "var(--space-sm) var(--space-md)",
                        textAlign: "left",
                        color: "var(--color-primary)",
                      }}
                    >
                      <a
                        href={preview.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: "var(--color-primary)",
                          textDecoration: "none",
                          wordBreak: "break-all",
                        }}
                      >
                        {preview.url}
                      </a>
                    </td>
                    <td
                      style={{
                        padding: "var(--space-sm) var(--space-md)",
                        textAlign: "left",
                        color: "var(--color-body)",
                      }}
                    >
                      {preview.status}
                    </td>
                    <td
                      style={{
                        padding: "var(--space-sm) var(--space-md)",
                        textAlign: "left",
                        color: "var(--color-body)",
                      }}
                    >
                      {formatTimestamp(preview.lastActiveAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!loadingPreviews && !errorPreviews && (!previews || previews.length === 0) && (
            <div style={{ color: "var(--color-muted)" }}>
              <span className="t-body-sm">No preview environments yet.</span>
            </div>
          )}
        </div>

        {/* CLI STATUS SECTION */}
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
            CLI Status
          </h2>

          {loadingCliStatus && (
            <div style={{ color: "var(--color-muted)" }}>
              <span className="t-body-sm">Loading CLI status…</span>
            </div>
          )}

          {errorCliStatus && (
            <div
              style={{
                backgroundColor: "rgba(239, 68, 68, 0.1)",
                border: "1px solid var(--color-accent-rose)",
                borderRadius: "var(--radius-md)",
                padding: "var(--space-sm)",
              }}
            >
              <p
                className="t-body-sm"
                style={{
                  color: "var(--color-accent-rose)",
                  margin: 0,
                }}
              >
                {errorCliStatus}
              </p>
            </div>
          )}

          {!loadingCliStatus && !errorCliStatus && cliStatus && cliStatus.length > 0 && (
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
                      textAlign: "left",
                      padding: "var(--space-sm) var(--space-md)",
                      color: "var(--color-muted)",
                      fontWeight: 600,
                      fontSize: 12,
                    }}
                  >
                    Binary
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
                    Installed
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
                    Latest
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
                    Update Available
                  </th>
                </tr>
              </thead>
              <tbody>
                {cliStatus.map((status) => (
                  <tr
                    key={status.provider}
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
                      {status.provider}
                    </td>
                    <td
                      style={{
                        padding: "var(--space-sm) var(--space-md)",
                        textAlign: "left",
                        color: "var(--color-body)",
                      }}
                    >
                      {status.bin}
                    </td>
                    <td
                      style={{
                        padding: "var(--space-sm) var(--space-md)",
                        textAlign: "left",
                        color: "var(--color-body)",
                      }}
                    >
                      {status.installed ?? "—"}
                    </td>
                    <td
                      style={{
                        padding: "var(--space-sm) var(--space-md)",
                        textAlign: "left",
                        color: "var(--color-body)",
                      }}
                    >
                      {status.latest ?? "—"}
                    </td>
                    <td
                      style={{
                        padding: "var(--space-sm) var(--space-md)",
                        textAlign: "center",
                      }}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          backgroundColor: status.updateAvailable
                            ? "var(--color-accent-amber)"
                            : "var(--color-success)",
                          color: "var(--color-canvas)",
                          padding: "var(--space-xxs) var(--space-xs)",
                          borderRadius: "var(--radius-pill)",
                          fontSize: 11,
                          fontWeight: 600,
                        }}
                      >
                        {status.updateAvailable ? "Yes" : "No"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!loadingCliStatus && !errorCliStatus && (!cliStatus || cliStatus.length === 0) && (
            <div style={{ color: "var(--color-muted)" }}>
              <span className="t-body-sm">No CLI binaries registered.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
