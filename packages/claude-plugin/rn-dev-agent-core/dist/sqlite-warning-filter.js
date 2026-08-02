import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);

// packages/rn-dev-agent-core/dist/sqlite-warning-filter.js
var SQLITE_EXPERIMENTAL_WARNING = "SQLite is an experimental feature and might change at any time";
var emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning, ...args) => {
  const isSqliteWarning = typeof warning === "string" && warning === SQLITE_EXPERIMENTAL_WARNING && args[0] === "ExperimentalWarning" || warning instanceof Error && warning.name === "ExperimentalWarning" && warning.message === SQLITE_EXPERIMENTAL_WARNING;
  if (isSqliteWarning)
    return;
  Reflect.apply(emitWarning, process, [warning, ...args]);
});
