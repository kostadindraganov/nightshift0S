/**
 * TerminalView — read-only xterm.js view of a live run's tmux pane (L4 / §D4).
 *
 * Opens a WebSocket to ws(s)://<host>/runs/<runId>/term?token=<bearer> (the
 * bearer is passed as a query param because browsers cannot set Authorization
 * on a WebSocket). The terminal is `disableStdin: true` — there is no path from
 * keystrokes back to the server, matching the server's structurally read-only
 * attach. Incoming bytes are written straight to the xterm instance; the fit
 * addon keeps the grid sized to its container.
 *
 * The socket carries raw pane bytes (capture-pane backlog + pipe-pane tail), so
 * messages are decoded as Uint8Array and written without re-encoding.
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getToken } from "../../lib/api.ts";

interface Props {
  runId: number;
}

type Status = "connecting" | "open" | "closed" | "error";

function wsUrl(runId: number, token: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/runs/${runId}/term?token=${encodeURIComponent(token)}`;
}

export function TerminalView({ runId }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>("connecting");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      convertEol: true,
      fontFamily: "var(--font-mono, monospace)",
      fontSize: 12,
      scrollback: 5000,
      theme: { background: "#0a0a0a", foreground: "#e4e4e7" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        // container may be detached during teardown; ignore.
      }
    };
    window.addEventListener("resize", onResize);

    setStatus("connecting");
    const ws = new WebSocket(wsUrl(runId, getToken()));
    ws.binaryType = "arraybuffer";

    ws.onopen = () => setStatus("open");
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
      } else if (typeof ev.data === "string") {
        term.write(ev.data);
      }
    };
    ws.onerror = () => setStatus("error");
    ws.onclose = () => setStatus((s) => (s === "error" ? s : "closed"));

    return () => {
      window.removeEventListener("resize", onResize);
      ws.close();
      term.dispose();
    };
  }, [runId]);

  const statusLabel: Record<Status, string> = {
    connecting: "Connecting…",
    open: "Live",
    closed: "Disconnected",
    error: "Connection error",
  };
  const statusColor: Record<Status, string> = {
    connecting: "var(--color-muted)",
    open: "var(--color-accent-green, var(--color-primary))",
    closed: "var(--color-muted)",
    error: "var(--color-accent-rose)",
  };

  return (
    <div
      style={{
        background: "var(--color-surface-card)",
        border: "1px solid var(--color-hairline)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minHeight: 200,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--space-xs) var(--space-md)",
          borderBottom: "1px solid var(--color-hairline)",
          flexShrink: 0,
        }}
      >
        <span className="t-caption-uppercase" style={{ color: "var(--color-muted)" }}>
          Live terminal
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            fontFamily: "var(--font-sans)",
            color: statusColor[status],
          }}
        >
          {statusLabel[status]}
        </span>
      </div>
      <div
        ref={hostRef}
        style={{
          flex: 1,
          minHeight: 160,
          padding: 6,
          background: "#0a0a0a",
        }}
      />
    </div>
  );
}

export default TerminalView;
