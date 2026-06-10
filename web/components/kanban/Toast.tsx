// Toast — small inline notification that auto-dismisses after 3 s.
import { useEffect, useState } from "react";

interface Props {
  message: string | null;
  onDismiss: () => void;
}

export function Toast({ message, onDismiss }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!message) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const t = setTimeout(() => {
      setVisible(false);
      onDismiss();
    }, 3000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  if (!visible || !message) return null;

  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        bottom: "var(--space-lg)",
        left: "50%",
        transform: "translateX(-50%)",
        background: "var(--color-surface-elevated)",
        border: "1px solid var(--color-error)",
        color: "var(--color-error)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-xs) var(--space-md)",
        fontSize: 13,
        fontWeight: 500,
        fontFamily: "var(--font-sans)",
        zIndex: 9999,
        maxWidth: 420,
        boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
        pointerEvents: "none",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {message}
    </div>
  );
}
