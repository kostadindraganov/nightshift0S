// Settings view — editable registry, auth health panel, and audit trail.
// Loads registry, settings, providers health, and audit events from the API.

import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type {
  SettingsRegistryEntry,
  EffectiveSetting,
  SettingOverride,
  ProviderHealth,
  NightshiftEvent,
} from "../lib/types";

interface RowState {
  key: string;
  editing: boolean;
  value: unknown;
  loading: boolean;
  message: string | null;
  messageKind: "success" | "error" | null;
}

export default function SettingsView() {
  // Registry & settings
  const [registry, setRegistry] = useState<SettingsRegistryEntry[] | null>(null);
  const [settings, setSettings] = useState<{
    entries: EffectiveSetting[];
    overrides: SettingOverride[];
  } | null>(null);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  // Provider health
  const [providers, setProviders] = useState<ProviderHealth[] | null>(null);

  // Audit trail
  const [auditEvents, setAuditEvents] = useState<NightshiftEvent[] | null>(null);

  // Global loading/error
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadAll = async () => {
      try {
        setLoading(true);
        setError(null);
        const [regData, settingsData, providersData, auditData] =
          await Promise.all([
            api.getSettingsRegistry(),
            api.getSettings(),
            api.getProvidersHealth(),
            api.getSettingsAudit(50),
          ]);
        setRegistry(regData);
        setSettings(settingsData);
        setProviders(providersData);
        setAuditEvents(auditData);

        // Initialize row states from registry
        const states: Record<string, RowState> = {};
        for (const knob of regData) {
          const entry = settingsData.entries.find(
            (e) => e.path === knob.configPath
          );
          states[knob.key] = {
            key: knob.key,
            editing: false,
            value: entry?.value ?? knob.default,
            loading: false,
            message: null,
            messageKind: null,
          };
        }
        setRowStates(states);
      } catch (err) {
        const message =
          err instanceof api.ApiError ? err.message : "Failed to load settings";
        setError(message);
      } finally {
        setLoading(false);
      }
    };
    loadAll();
  }, []);

  // Find effective entry by path
  const getEffectiveValue = (configPath: string) => {
    return settings?.entries.find((e) => e.path === configPath)?.value;
  };

  // Find source badge info
  const getSourceBadge = (configPath: string) => {
    const entry = settings?.entries.find((e) => e.path === configPath);
    return entry?.source ?? "unknown";
  };

  // Save a setting
  const handleSave = async (knob: SettingsRegistryEntry) => {
    setRowStates((prev) => ({
      ...prev,
      [knob.key]: { ...prev[knob.key]!, loading: true },
    }));
    try {
      let value = rowStates[knob.key]!.value;
      if (knob.type === "number" && typeof value === "string") {
        value = Number(value);
      } else if (knob.type === "boolean" && typeof value === "string") {
        value = value === "true";
      } else if (knob.type === "stringArray" && typeof value === "string") {
        value = value.split(",").map((s) => s.trim());
      }

      await api.putSetting("global", knob.key, {
        value,
        updated_by: "ui",
      });

      setRowStates((prev) => ({
        ...prev,
        [knob.key]: {
          ...prev[knob.key]!,
          loading: false,
          message: "Saved",
          messageKind: "success",
        },
      }));

      // Reload settings after a short delay
      setTimeout(async () => {
        try {
          const freshSettings = await api.getSettings();
          setSettings(freshSettings);
          setRowStates((prev) => ({
            ...prev,
            [knob.key]: {
              ...prev[knob.key]!,
              value: freshSettings.entries.find(
                (e) => e.path === knob.configPath
              )?.value ?? knob.default,
              message: null,
              messageKind: null,
            },
          }));
        } catch {
          // ignore reload error
        }
      }, 500);
    } catch (err) {
      const msg =
        err instanceof api.ApiError
          ? err.message
          : "Failed to save setting";
      setRowStates((prev) => ({
        ...prev,
        [knob.key]: {
          ...prev[knob.key]!,
          loading: false,
          message: msg,
          messageKind: "error",
        },
      }));
    }
  };

  // Revert a setting
  const handleRevert = async (knob: SettingsRegistryEntry) => {
    setRowStates((prev) => ({
      ...prev,
      [knob.key]: { ...prev[knob.key]!, loading: true },
    }));
    try {
      await api.deleteSetting("global", knob.key);

      setRowStates((prev) => ({
        ...prev,
        [knob.key]: {
          ...prev[knob.key]!,
          loading: false,
          message: "Reverted",
          messageKind: "success",
        },
      }));

      // Reload settings after a short delay
      setTimeout(async () => {
        try {
          const freshSettings = await api.getSettings();
          setSettings(freshSettings);
          setRowStates((prev) => ({
            ...prev,
            [knob.key]: {
              ...prev[knob.key]!,
              value: freshSettings.entries.find(
                (e) => e.path === knob.configPath
              )?.value ?? knob.default,
              message: null,
              messageKind: null,
            },
          }));
        } catch {
          // ignore reload error
        }
      }, 500);
    } catch (err) {
      const msg =
        err instanceof api.ApiError
          ? err.message
          : "Failed to revert setting";
      setRowStates((prev) => ({
        ...prev,
        [knob.key]: {
          ...prev[knob.key]!,
          loading: false,
          message: msg,
          messageKind: "error",
        },
      }));
    }
  };

  // Render source badge with db:* colors
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
    } else if (source === "db:global" || source === "db:project" || source === "db:routine") {
      bgColor = "var(--color-primary)";
      fgColor = "var(--color-on-primary)";
      label = source;
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

  // Render health status pill
  const renderHealthPill = (status: string) => {
    let bgColor = "var(--color-muted)";
    let fgColor = "var(--color-canvas)";

    if (status === "healthy") {
      bgColor = "var(--color-success)";
      fgColor = "var(--color-on-success)";
    } else if (status === "degraded") {
      bgColor = "var(--color-accent-amber)";
      fgColor = "var(--color-canvas)";
    } else if (status === "cooling_down") {
      bgColor = "var(--color-accent-blue)";
      fgColor = "var(--color-canvas)";
    } else if (status === "circuit_open" || status === "disabled") {
      bgColor = "var(--color-accent-rose)";
      fgColor = "var(--color-canvas)";
    } else if (status === "unproven") {
      bgColor = "var(--color-muted)";
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
          Editable registry, auth health, and audit trail — V1.5 (§3.12.19).
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
            <span className="t-body-sm">Loading settings…</span>
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

        {!loading && !error && (
          <>
            {/* EDITABLE REGISTRY */}
            {registry && registry.length > 0 && (
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
                    marginBottom: "var(--space-md)",
                    color: "var(--color-ink)",
                  }}
                >
                  Editable Registry
                </h2>

                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
                  {registry.map((knob) => {
                    const rowState = rowStates[knob.key] || {
                      key: knob.key,
                      editing: false,
                      value: getEffectiveValue(knob.configPath) ?? knob.default,
                      loading: false,
                      message: null,
                      messageKind: null,
                    };
                    const sourceBadge = getSourceBadge(knob.configPath);

                    return (
                      <div
                        key={knob.key}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: "var(--space-md)",
                          padding: "var(--space-sm)",
                          borderTop: "1px solid var(--color-hairline)",
                        }}
                      >
                        {/* Label + path */}
                        <div style={{ minWidth: 180, flex: "0 0 auto" }}>
                          <span
                            className="t-body-sm"
                            style={{
                              fontFamily: "var(--font-mono)",
                              color: "var(--color-body-strong)",
                              display: "block",
                            }}
                          >
                            {knob.key}
                          </span>
                          <span
                            className="t-caption"
                            style={{
                              color: "var(--color-muted)",
                              display: "block",
                              fontSize: 11,
                            }}
                          >
                            {knob.configPath}
                          </span>
                        </div>

                        {/* Editor */}
                        <div style={{ flex: 1, minWidth: 200 }}>
                          {knob.type === "boolean" ? (
                            <select
                              value={rowState.value === true ? "true" : "false"}
                              onChange={(e) => {
                                setRowStates((prev) => ({
                                  ...prev,
                                  [knob.key]: {
                                    ...prev[knob.key]!,
                                    value: e.target.value === "true",
                                  },
                                }));
                              }}
                              disabled={rowState.loading}
                              style={{
                                width: "100%",
                                padding: "var(--space-xs) var(--space-sm)",
                                border: "1px solid var(--color-hairline)",
                                borderRadius: "var(--radius-md)",
                                backgroundColor: "var(--color-canvas)",
                                color: "var(--color-ink)",
                                fontFamily: "var(--font-sans)",
                                fontSize: 14,
                              }}
                            >
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>
                          ) : knob.secret ? (
                            <input
                              type="password"
                              placeholder="••••••"
                              value={String(rowState.value || "")}
                              onChange={(e) => {
                                setRowStates((prev) => ({
                                  ...prev,
                                  [knob.key]: {
                                    ...prev[knob.key]!,
                                    value: e.target.value,
                                  },
                                }));
                              }}
                              disabled={rowState.loading}
                              style={{
                                width: "100%",
                                padding: "var(--space-xs) var(--space-sm)",
                                border: "1px solid var(--color-hairline)",
                                borderRadius: "var(--radius-md)",
                                backgroundColor: "var(--color-canvas)",
                                color: "var(--color-ink)",
                                fontFamily: "var(--font-sans)",
                                fontSize: 14,
                              }}
                            />
                          ) : (
                            <input
                              type={knob.type === "number" ? "number" : "text"}
                              placeholder={String(knob.default || "")}
                              value={String(rowState.value || "")}
                              onChange={(e) => {
                                setRowStates((prev) => ({
                                  ...prev,
                                  [knob.key]: {
                                    ...prev[knob.key]!,
                                    value: e.target.value,
                                  },
                                }));
                              }}
                              disabled={rowState.loading}
                              style={{
                                width: "100%",
                                padding: "var(--space-xs) var(--space-sm)",
                                border: "1px solid var(--color-hairline)",
                                borderRadius: "var(--radius-md)",
                                backgroundColor: "var(--color-canvas)",
                                color: "var(--color-ink)",
                                fontFamily:
                                  knob.type === "stringArray"
                                    ? "var(--font-mono)"
                                    : "var(--font-sans)",
                                fontSize: 14,
                              }}
                            />
                          )}
                        </div>

                        {/* Source badge */}
                        <div style={{ flex: "0 0 auto" }}>
                          {renderSourceBadge(sourceBadge)}
                        </div>

                        {/* Buttons */}
                        <div
                          style={{
                            display: "flex",
                            gap: "var(--space-xs)",
                            flex: "0 0 auto",
                          }}
                        >
                          <button
                            onClick={() => handleSave(knob)}
                            disabled={rowState.loading}
                            style={{
                              padding: "var(--space-xs) var(--space-sm)",
                              backgroundColor: "var(--color-primary)",
                              color: "var(--color-on-primary)",
                              border: "none",
                              borderRadius: "var(--radius-md)",
                              fontFamily: "var(--font-sans)",
                              fontSize: 13,
                              fontWeight: 600,
                              cursor: rowState.loading ? "not-allowed" : "pointer",
                              opacity: rowState.loading ? 0.6 : 1,
                            }}
                          >
                            {rowState.loading ? "…" : "Save"}
                          </button>
                          <button
                            onClick={() => handleRevert(knob)}
                            disabled={rowState.loading}
                            style={{
                              padding: "var(--space-xs) var(--space-sm)",
                              backgroundColor: "transparent",
                              color: "var(--color-ink)",
                              border: "1px solid var(--color-hairline)",
                              borderRadius: "var(--radius-md)",
                              fontFamily: "var(--font-sans)",
                              fontSize: 13,
                              fontWeight: 600,
                              cursor: rowState.loading ? "not-allowed" : "pointer",
                              opacity: rowState.loading ? 0.6 : 1,
                            }}
                          >
                            Revert
                          </button>
                        </div>

                        {/* Feedback */}
                        {rowState.message && (
                          <div
                            style={{
                              flex: "0 0 auto",
                              fontSize: 12,
                              color:
                                rowState.messageKind === "error"
                                  ? "var(--color-accent-rose)"
                                  : "var(--color-success)",
                            }}
                          >
                            {rowState.message}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* AUTH HEALTH */}
            {providers && providers.length > 0 && (
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
                    marginBottom: "var(--space-md)",
                    color: "var(--color-ink)",
                  }}
                >
                  Auth Health
                </h2>

                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 13,
                  }}
                >
                  <tbody>
                    {providers.map((provider, idx) => (
                      <tr
                        key={provider.name}
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
                            color: "var(--color-body-strong)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {provider.name}
                        </td>
                        <td
                          style={{
                            paddingTop: "var(--space-sm)",
                            paddingBottom: "var(--space-sm)",
                            paddingRight: "var(--space-md)",
                            textAlign: "left",
                            color: "var(--color-body)",
                          }}
                        >
                          <span className="t-caption" style={{ color: "var(--color-muted)" }}>
                            {provider.kind}
                          </span>
                        </td>
                        <td
                          style={{
                            paddingTop: "var(--space-sm)",
                            paddingBottom: "var(--space-sm)",
                            paddingRight: "var(--space-md)",
                            textAlign: "center",
                          }}
                        >
                          {renderHealthPill(provider.status)}
                        </td>
                        <td
                          style={{
                            paddingTop: "var(--space-sm)",
                            paddingBottom: "var(--space-sm)",
                            paddingRight: "var(--space-md)",
                            textAlign: "left",
                            color: "var(--color-muted)",
                            fontSize: 12,
                            maxWidth: 300,
                            wordBreak: "break-word",
                          }}
                        >
                          {provider.lastError
                            ? provider.lastError.substring(0, 60) + "…"
                            : "-"}
                        </td>
                        <td
                          style={{
                            paddingTop: "var(--space-sm)",
                            paddingBottom: "var(--space-sm)",
                            textAlign: "right",
                            color: "var(--color-muted)",
                            fontSize: 12,
                          }}
                        >
                          {provider.cooldownUntil
                            ? new Date(provider.cooldownUntil).toLocaleTimeString()
                            : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* AUDIT TRAIL */}
            {auditEvents && auditEvents.length > 0 && (
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
                    marginBottom: "var(--space-md)",
                    color: "var(--color-ink)",
                  }}
                >
                  Recent Events
                </h2>

                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
                  {auditEvents.map((event, idx) => {
                    let summary = "";
                    try {
                      const payload = JSON.parse(event.payloadJson);
                      if (event.kind === "settings_updated") {
                        summary = `${payload.scope}/${payload.key} by ${payload.updatedBy || "?"}`;
                      } else {
                        summary = event.kind;
                      }
                    } catch {
                      summary = event.kind;
                    }

                    return (
                      <div
                        key={event.id}
                        style={{
                          display: "flex",
                          gap: "var(--space-md)",
                          paddingTop: "var(--space-sm)",
                          paddingBottom: "var(--space-sm)",
                          borderTop:
                            idx === 0
                              ? "none"
                              : "1px solid var(--color-hairline)",
                          fontSize: 13,
                        }}
                      >
                        <span
                          className="t-caption"
                          style={{
                            color: "var(--color-muted)",
                            fontFamily: "var(--font-mono)",
                            flex: "0 0 auto",
                          }}
                        >
                          {new Date(event.ts).toLocaleTimeString()}
                        </span>
                        <span
                          style={{
                            color: "var(--color-body-strong)",
                            fontFamily: "var(--font-mono)",
                            flex: "0 0 auto",
                          }}
                        >
                          {event.kind}
                        </span>
                        <span style={{ color: "var(--color-body)" }}>
                          {summary}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
