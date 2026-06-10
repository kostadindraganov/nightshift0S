// Entry point — mounts the React app into #root.
// jsx=react-jsx is configured in tsconfig so no React import is needed.
import { createRoot } from "react-dom/client";
import App from "./app/App.tsx";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
