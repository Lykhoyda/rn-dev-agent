import { logger } from '../logger.js';
import { resetState, clearActiveFlag, sleep } from './state.js';
import type { ResettableState } from './state.js';

const RECONNECT_DELAY_MS = 1500;
const RECONNECT_ATTEMPTS = 30;
const RECONNECT_RETRY_MS = 1500;

export interface ReconnectContext {
  isDisposed: () => boolean;
  isReconnecting: () => boolean;
  isSoftReconnectRequested: () => boolean;
  setReconnecting: (v: boolean) => void;
  setSoftReconnectRequested: (v: boolean) => void;
  setState: (s: string) => void;
  setReconnectAttempt: (count: number, timestamp: string) => void;
  closeWs: () => void;
  rejectAllPending: (reason: Error) => void;
  discoverAndConnect: () => Promise<string>;
  getResettableState: () => ResettableState;
  getPort: () => number;
  setBgPollTimer: (timer: ReturnType<typeof setInterval> | null) => void;
  getBgPollTimer: () => ReturnType<typeof setInterval> | null;
  isConnected: () => boolean;
}

export function handleClose(ctx: ReconnectContext, code: number): void {
  resetState(ctx.getResettableState());

  if (ctx.isDisposed() || ctx.isReconnecting()) return;

  logger.info('CDP', `WebSocket closed (code ${code}), starting reconnect`);
  if (code === 1006) {
    console.error('CDP: abnormal close (1006). App may have reloaded or crashed. Attempting reconnect...');
  } else {
    console.error('CDP: connection closed (code ' + code + '). Reconnecting...');
  }

  ctx.setReconnecting(true);
  ctx.setState('reconnecting');

  reconnect(ctx).catch((err) => {
    console.error('CDP: reconnect failed:', err instanceof Error ? err.message : err);
    ctx.setReconnecting(false);
  });
}

export async function reconnect(ctx: ReconnectContext): Promise<void> {
  await sleep(RECONNECT_DELAY_MS);

  for (let i = 0; i < RECONNECT_ATTEMPTS; i++) {
    ctx.setReconnectAttempt(i + 1, new Date().toISOString());
    if (ctx.isDisposed() || ctx.isSoftReconnectRequested()) {
      ctx.setReconnecting(false);
      return;
    }
    try {
      await ctx.discoverAndConnect();
      ctx.setReconnecting(false);
      console.error('CDP: reconnected successfully');
      return;
    } catch {
      if (i < RECONNECT_ATTEMPTS - 1) {
        if (ctx.isSoftReconnectRequested()) {
          ctx.setReconnecting(false);
          return;
        }
        await sleep(RECONNECT_RETRY_MS);
      }
    }
  }
  ctx.setReconnecting(false);
  ctx.setState('disconnected');
  clearActiveFlag();
  console.error('CDP: reconnect failed after ' + RECONNECT_ATTEMPTS + ' attempts. Starting background poll...');
  startBackgroundPoll(ctx);
}

export async function softReconnect(ctx: ReconnectContext): Promise<string> {
  if (ctx.isDisposed()) throw new Error('Client is disposed');
  logger.info('CDP', 'softReconnect initiated');

  if (ctx.isReconnecting()) {
    ctx.setSoftReconnectRequested(true);
    const bailDeadline = Date.now() + 3_000;
    while (ctx.isReconnecting() && Date.now() < bailDeadline) {
      await sleep(200);
    }
    ctx.setSoftReconnectRequested(false);
  }

  ctx.setReconnecting(true);
  try {
    resetState(ctx.getResettableState());
    ctx.closeWs();
    ctx.rejectAllPending(new Error('Stale target — re-discovering'));
    const result = await ctx.discoverAndConnect();
    ctx.setReconnecting(false);
    return result;
  } catch (err) {
    ctx.setReconnecting(false);
    throw err;
  }
}

export function startBackgroundPoll(ctx: ReconnectContext): void {
  if (ctx.getBgPollTimer() || ctx.isDisposed()) return;
  ctx.setBgPollTimer(setInterval(async () => {
    if (ctx.isDisposed() || ctx.isConnected() || ctx.isReconnecting()) {
      stopBackgroundPoll(ctx);
      return;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.getPort()}/status`, {
        signal: AbortSignal.timeout(2000),
      });
      const text = await res.text();
      if (text === 'packager-status:running') {
        console.error('CDP: Metro detected via background poll. Reconnecting...');
        stopBackgroundPoll(ctx);
        ctx.setReconnecting(true);
        ctx.setState('reconnecting');
        reconnect(ctx).catch(() => { ctx.setReconnecting(false); });
      }
    } catch {
      // Metro not available yet — keep polling
    }
  }, 5000));
}

export function stopBackgroundPoll(ctx: ReconnectContext): void {
  const timer = ctx.getBgPollTimer();
  if (timer) {
    clearInterval(timer);
    ctx.setBgPollTimer(null);
  }
}
