export const SQLITE_RELAUNCH_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGUSR2'] as const;

export interface ChildErrorOrExitOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

export interface ChildErrorOrExitHandle {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill?(signal?: NodeJS.Signals): boolean | void;
}

export interface SqliteRelaunchIo {
  writeErrorLine: (line: string) => void;
  exit: (code: number) => void;
  killSelf: (signal: NodeJS.Signals) => void;
  removeSignalListeners: (signal: NodeJS.Signals) => void;
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
}

export function processSqliteRelaunchIo(): SqliteRelaunchIo {
  return {
    writeErrorLine: (line) => {
      process.stderr.write(`${line}\n`);
    },
    exit: (code) => {
      process.exit(code);
    },
    killSelf: (signal) => {
      process.kill(process.pid, signal);
    },
    removeSignalListeners: (signal) => {
      process.removeAllListeners(signal);
    },
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
  };
}

/** Settles once when a child emits `error`, `exit`, or both. */
export function awaitChildErrorOrExit(
  child: ChildErrorOrExitHandle,
): Promise<ChildErrorOrExitOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: ChildErrorOrExitOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.on('error', (err) =>
      settle({
        code: null,
        signal: null,
        error: err instanceof Error ? err : new Error(String(err)),
      }),
    );
    child.on('exit', (code, signal) => settle({ code, signal, error: null }));
  });
}

export async function completeSqliteRelaunch(
  child: ChildErrorOrExitHandle,
  io: SqliteRelaunchIo = processSqliteRelaunchIo(),
): Promise<void> {
  for (const signal of SQLITE_RELAUNCH_SIGNALS) {
    io.onSignal(signal, () => {
      try {
        child.kill?.(signal);
      } catch {
        /* already gone */
      }
    });
  }
  const outcome = await awaitChildErrorOrExit(child);
  if (outcome.error) {
    io.writeErrorLine(
      `rn-bridge-supervisor: sqlite relaunch spawn failed: ${outcome.error.message}`,
    );
    io.exit(1);
    return;
  }
  if (outcome.signal) {
    io.removeSignalListeners(outcome.signal);
    io.killSelf(outcome.signal);
  }
  io.exit(outcome.code ?? 1);
}
