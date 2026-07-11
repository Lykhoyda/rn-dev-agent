// GH #438 — single source of truth for the observe-UI wire shapes.
// PURE TYPES ONLY: this module must never gain a runtime or Node import.
// The browser SPA (src/observability/web) `import type`s it directly — its
// previous hand-copied twins in web/src/types.ts drifted silently (the
// #348/#351 class); a Node import here would leak `node:*` builtins into the
// vite bundle.
export {};
