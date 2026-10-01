export const NATIVE_PRESENCE_BUDGET_MS = 20_000;
export const CAPTURE_BUDGET_MS = 22_000;
export const EVIDENCE_USE_MS = 10_000;
export const MAX_EVIDENCE_AGE_MS = 32_000;
export const PHRASE_WAIT_BUDGET_MS = 65_000;

export interface ObservationTiming {
  readonly startedAt: number;
  readonly completedAt: number;
  readonly expiresAt: number;
}

export function admitObservation(
  startedAt: number,
  completedAt: number,
): ObservationTiming | undefined {
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    startedAt < 0 ||
    completedAt < startedAt ||
    completedAt - startedAt >= CAPTURE_BUDGET_MS
  ) {
    return undefined;
  }
  return {
    startedAt,
    completedAt,
    expiresAt: Math.min(completedAt + EVIDENCE_USE_MS, startedAt + MAX_EVIDENCE_AGE_MS),
  };
}

export function observationDeadline(timing: ObservationTiming, itemDeadline = Infinity): number {
  return Math.min(timing.expiresAt, itemDeadline);
}

export function observationUsable(
  timing: ObservationTiming,
  now: number,
  itemDeadline = Infinity,
): boolean {
  return (
    Number.isFinite(now) &&
    now >= timing.completedAt &&
    now < observationDeadline(timing, itemDeadline)
  );
}
