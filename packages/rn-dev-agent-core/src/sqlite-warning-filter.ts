const SQLITE_EXPERIMENTAL_WARNING =
  'SQLite is an experimental feature and might change at any time';

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const isSqliteWarning =
    (typeof warning === 'string' &&
      warning === SQLITE_EXPERIMENTAL_WARNING &&
      args[0] === 'ExperimentalWarning') ||
    (warning instanceof Error &&
      warning.name === 'ExperimentalWarning' &&
      warning.message === SQLITE_EXPERIMENTAL_WARNING);
  if (isSqliteWarning) return;
  Reflect.apply(emitWarning, process, [warning, ...args]);
}) as typeof process.emitWarning;
