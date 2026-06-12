/**
 * WHY: TerminalView imports `@xterm/xterm/css/xterm.css` as a side-effect so
 * Bun's HTML bundler ships xterm's stylesheet. Raw `tsc --noEmit` has no CSS
 * loader and would error TS2882 on that import; this ambient declaration tells
 * the type-checker the import is a void side-effect (Bun handles the bundling).
 */
declare module "*.css";
