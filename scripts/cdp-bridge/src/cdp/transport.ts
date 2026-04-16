import WebSocket from 'ws';
import type { CDPMessage, PendingCall } from '../types.js';

export function sendWithTimeout(
  ws: WebSocket | null,
  pending: Map<number, PendingCall>,
  nextId: () => number,
  method: string,
  params: unknown,
  ms: number,
): Promise<unknown> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('WebSocket not connected'));
  }

  return new Promise((resolve, reject) => {
    const id = nextId();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(
        `CDP timeout (${ms}ms): ${method}. JS thread may be blocked, paused on a breakpoint, or waiting on an unresolved promise.`
      ));
    }, ms);

    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    try {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('WebSocket closed between check and send');
      }
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(`ws.send failed: ${err}`));
    }
  });
}

export function rejectAllPending(pending: Map<number, PendingCall>, reason: Error): void {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(reason);
  }
  pending.clear();
}

export function handleMessage(
  data: WebSocket.RawData,
  pending: Map<number, PendingCall>,
  eventHandlers: Map<string, (params: unknown) => void>,
  onConsoleHook?: (params: unknown) => void,
): void {
  try {
    const msg = JSON.parse(data.toString()) as CDPMessage;

    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      console.error('CDP: unexpected message shape, ignoring');
      return;
    }

    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(msg.error.message));
      } else {
        p.resolve(msg.result);
      }
    } else if (msg.method) {
      const handler = eventHandlers.get(msg.method);
      if (handler) handler(msg.params);

      if (msg.method === 'Runtime.consoleAPICalled' && onConsoleHook) {
        onConsoleHook(msg.params);
      }
    }
  } catch (err) {
    console.error('CDP: malformed message:', err instanceof Error ? err.message : err);
  }
}
