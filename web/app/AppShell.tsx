// App chrome: sidebar navigation + topbar + main content area.
// Adapted from the ui-reference sidebar structure but rewritten clean:
// no Next.js, no @/ imports, no shadcn — just React + CSS tokens.

type View = "board" | "intake" | "routines" | "settings";

interface AppShellProps {
  view: View;
  onNavigate: (v: View) => void;
  connected: boolean;
  children: React.ReactNode;
}

const NAV_ITEMS: { id: View; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "intake", label: "Intake" },
  { id: "routines", label: "Routines" },
  { id: "settings", label: "Settings" },
];

const VIEW_TITLES: Record<View, string> = {
  board: "Board",
  intake: "Intake",
  routines: "Routines",
  settings: "Settings",
};

export default function AppShell({ view, onNavigate, connected, children }: AppShellProps) {
  return (
    <div className="app-shell">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo-mark" aria-hidden="true" />
          <span className="sidebar-wordmark">Nightshift</span>
        </div>

        <nav className="sidebar-nav" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`sidebar-nav-item${view === item.id ? " active" : ""}`}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => onNavigate(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span
            className={`live-dot ${connected ? "connected" : "disconnected"}`}
            aria-hidden="true"
          />
          <span
            style={{
              fontSize: 12,
              color: connected ? "var(--color-success)" : "var(--color-muted)",
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
            }}
          >
            {connected ? "Live" : "Offline"}
          </span>
        </div>
      </aside>

      {/* ── Topbar ── */}
      <header className="topbar">
        <span className="topbar-title">{VIEW_TITLES[view]}</span>
        <div className="topbar-chip">
          <span
            className={`live-dot ${connected ? "connected" : "disconnected"}`}
            aria-hidden="true"
            style={{ width: 6, height: 6 }}
          />
          {connected ? "connected" : "offline"}
        </div>
      </header>

      {/* ── Main ── */}
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
