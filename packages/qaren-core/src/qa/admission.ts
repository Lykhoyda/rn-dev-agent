import { loadavg } from 'node:os';
import { HandlerError, describeError } from './adapt.js';
import type { ProveOutcome } from './prove.js';

// A timed case counts only at a 1-minute host load at or below this (captain's 2026-10-03 rule).
export const LOAD_ENVELOPE = 10;

const STOP_POLL_MS = 100;

export interface AdmissionSteps {
  metroPort: number;
  attach(): Promise<void>;
  // The message of a foreign automation driver holding the device, if any.
  foreignDriver(): Promise<string | undefined>;
  open(): Promise<void>;
  prove(): Promise<ProveOutcome>;
  close(): Promise<void>;
  load?(): number;
}

type Proven = Extract<ProveOutcome, { ok: true }>;

// Every setup effect runs only while the run is not stopping; a stop closes what was opened.
export async function admit(
  steps: AdmissionSteps,
  stop: { readonly stopping: boolean },
): Promise<Proven> {
  const halt = async (): Promise<void> => {
    if (!stop.stopping) return;
    await steps.close();
    throw new HandlerError(
      'RUN_CANCELLED',
      'the run was cancelled while opening the device session',
    );
  };
  await halt();
  await attach(steps, stop, halt);
  await halt();
  const foreign = await steps.foreignDriver();
  if (foreign !== undefined) {
    await steps.close();
    throw new HandlerError('BUSY_FOREIGN_FLOW', foreign);
  }
  await halt();
  await steps.open();
  await halt();
  const proof = await steps.prove();
  if (!proof.ok) {
    await steps.close();
    throw new HandlerError(proof.code, proof.message);
  }
  return proof;
}

async function attach(
  steps: AdmissionSteps,
  stop: { readonly stopping: boolean },
  halt: () => Promise<void>,
): Promise<void> {
  const attempt = async (): Promise<string | undefined> => {
    try {
      await untilStopped(steps.attach(), stop);
      return undefined;
    } catch (error) {
      return describeError(error).message;
    }
  };
  let failure = await attempt();
  if (failure === undefined) return;
  await halt();
  const load = (steps.load ?? (() => loadavg()[0]))();
  const loaded = load > LOAD_ENVELOPE;
  if (loaded) {
    failure = await attempt();
    if (failure === undefined) return;
    await halt();
  }
  await steps.close();
  const measured = `host 1-minute load ${load.toFixed(1)} is ${loaded ? 'above' : 'within'} the envelope ${LOAD_ENVELOPE}`;
  throw new HandlerError(
    'CDP_NOT_CONNECTED',
    `cannot attach to the dev client through Metro ${steps.metroPort}: ${failure} (${
      loaded ? `${measured}; an environment refusal after one retry` : measured
    })`,
  );
}

// Resolves with the operation, or rejects as soon as the run is stopping.
function untilStopped<T>(op: Promise<T>, stop: { readonly stopping: boolean }): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      if (stop.stopping) reject(new Error('the run is stopping'));
    }, STOP_POLL_MS);
  });
  return Promise.race([op, stopped]).finally(() => clearInterval(timer));
}
