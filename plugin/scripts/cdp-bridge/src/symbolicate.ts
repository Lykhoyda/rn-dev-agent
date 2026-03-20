import type { ErrorEntry } from './types.js';

interface StackFrame {
  methodName: string;
  file: string;
  lineNumber: number;
  column: number;
}

const HERMES_AT_RE = /^\s*at\s+(?:(.+?)\s+)?\(?(https?:\/\/[^):]+(?::\d+)?\/[^):]+):(\d+):(\d+)\)?/;
const HERMES_ATSIGN_RE = /^\s*(.*?)@(.+):(\d+):(\d+)\s*$/;

const SYMBOLICATE_TIMEOUT_MS = 3000;

export function parseHermesStack(rawStack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of rawStack.split('\n')) {
    const match = HERMES_AT_RE.exec(line) || HERMES_ATSIGN_RE.exec(line);
    if (match) {
      frames.push({
        methodName: match[1] || '<anonymous>',
        file: match[2],
        lineNumber: parseInt(match[3], 10),
        column: parseInt(match[4], 10),
      });
    }
  }
  return frames;
}

function formatSymbolicatedStack(frames: StackFrame[]): string {
  return frames
    .map(f => `  at ${f.methodName} (${f.file}:${f.lineNumber}:${f.column})`)
    .join('\n');
}

export async function symbolicateErrors(
  errors: ErrorEntry[],
  metroPort: number,
): Promise<ErrorEntry[]> {
  const allFrames: StackFrame[] = [];
  const frameRanges: Array<{ start: number; end: number }> = [];

  for (const error of errors) {
    const frames = error.stack ? parseHermesStack(error.stack) : [];
    frameRanges.push({ start: allFrames.length, end: allFrames.length + frames.length });
    allFrames.push(...frames);
  }

  if (allFrames.length === 0) return errors;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYMBOLICATE_TIMEOUT_MS);
  try {
    const resp = await fetch(`http://127.0.0.1:${metroPort}/symbolicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: allFrames }),
      signal: ctrl.signal,
    });

    if (!resp.ok) return errors;

    const body = await resp.json() as { stack?: StackFrame[] };
    const resultFrames = body.stack;
    if (!Array.isArray(resultFrames) || resultFrames.length !== allFrames.length) {
      return errors;
    }

    return errors.map((error, i) => {
      const range = frameRanges[i];
      if (range.start === range.end) return error;
      const symbolicated = resultFrames.slice(range.start, range.end);
      return { ...error, stack: formatSymbolicatedStack(symbolicated) };
    });
  } catch {
    return errors;
  } finally {
    clearTimeout(timer);
  }
}
