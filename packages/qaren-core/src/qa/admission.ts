import { loadavg } from 'node:os';
import { interruptible, withCancellation, withDeadline, isAbort } from '../domain/cancellation.js';
import { TargetReadinessTimeoutError } from '../cdp/discovery.js';
import { CDPProbeTimeoutError, CDPHandshakeTimeoutError } from '../cdp/connect.js';
import { HandlerError, describeError } from './adapt.js';
import type { ProveOutcome } from './prove.js';

export const LOAD_ENVELOPE = 10;

export interface AdmissionSteps {
  metroPort: number;
  readinessMs: number;
  remainingMs(): number;
  attach(deadline: number): Promise<void>;
  // A launch stuck on the dev-launcher never recovers by waiting: the one retry relaunches first.
  relaunch?(): Promise<void>;
  foreignDriver(): Promise<string | undefined>;
  open(): Promise<void>;
  prove(): Promise<ProveOutcome>;
  close(): Promise<void>;
  load?(): number;
}

type Proven = Extract<ProveOutcome, { ok: true }>;

export async function admit(
  steps: AdmissionSteps,
  stop: { readonly signal: AbortSignal },
): Promise<Proven> {
  try {
    return await withCancellation(stop.signal, async () => {
      await attach(steps);
      await refuseForeignDriver(steps);
      await interruptible(steps.open);
      const proof = await interruptible(steps.prove);
      if (!proof.ok) throw new HandlerError(proof.code, proof.message);
      return proof;
    });
  } catch (error) {
    await withCancellation(undefined, steps.close);
    stop.signal.throwIfAborted();
    throw error;
  }
}

async function refuseForeignDriver(steps: AdmissionSteps): Promise<void> {
  const foreign = await interruptible(steps.foreignDriver);
  if (foreign !== undefined) throw new HandlerError('BUSY_FOREIGN_FLOW', foreign);
}

async function attach(steps: AdmissionSteps): Promise<void> {
  let failure: unknown;
  try {
    const deadline = performance.now() + steps.remainingMs();
    await withDeadline(deadline, new CDPProbeTimeoutError('CDP attach deadline exceeded'), () =>
      steps.attach(deadline),
    );
    return;
  } catch (error) {
    if (isAbort(error)) throw error;
    failure = error;
  }
  const load = (steps.load ?? (() => loadavg()[0]))();
  const loaded = load > LOAD_ENVELOPE;
  const timedOut = (error: unknown) =>
    error instanceof TargetReadinessTimeoutError ||
    error instanceof CDPProbeTimeoutError ||
    error instanceof CDPHandshakeTimeoutError;
  const retry = loaded && timedOut(failure) && steps.remainingMs() >= steps.readinessMs;
  let relaunchFailure: string | undefined;
  if (retry && steps.relaunch) {
    await refuseForeignDriver(steps);
    try {
      await interruptible(steps.relaunch);
    } catch (error) {
      if (isAbort(error)) throw error;
      relaunchFailure = describeError(error).message;
    }
  }
  if (retry && relaunchFailure === undefined) {
    try {
      const deadline = performance.now() + steps.remainingMs();
      await withDeadline(deadline, new CDPProbeTimeoutError('CDP attach deadline exceeded'), () =>
        steps.attach(deadline),
      );
      return;
    } catch (error) {
      if (isAbort(error)) throw error;
      failure = error;
    }
  }
  const environment = loaded && timedOut(failure);
  const measured = `host 1-minute load ${load.toFixed(1)} is ${loaded ? 'above' : 'within'} the envelope ${LOAD_ENVELOPE}`;
  throw new HandlerError(
    'CDP_NOT_CONNECTED',
    `cannot attach to the dev client through Metro ${steps.metroPort}: ${describeError(failure).message} (${measured}${environment ? `; an environment refusal ${retry ? 'after one retry' : 'without enough budget for another readiness wait'}` : ''}${relaunchFailure === undefined ? '' : `; relaunch failed: ${relaunchFailure}`})`,
  );
}
