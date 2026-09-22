import type { Block, Item } from './plan.js';
import { type Screen, screenSignature } from './screen.js';
import {
  type ScreenDecision,
  CHECK,
  ResolutionError,
  decideScreen,
  resolutionVisible,
  targetVisible,
} from './resolve.js';
import { type Judge, type JevCall, JevError, unavailableJudge } from './questions.js';
import { maskInputs, ObservedPrivacy } from './privacy.js';
import {
  type BlockResult,
  type WalkResult,
  type LedgerFailure,
  type LedgerRow,
  buildLedger,
  screenshotName,
} from './ledger.js';

export interface ActResult {
  ok: boolean;
  proven: boolean;
  error?: string;
}

export interface WalkerDeps {
  judge?: Judge;
  captureScreen(): Promise<Screen>;
  press(ref: string): Promise<ActResult>;
  fill(ref: string, text: string): Promise<ActResult>;
  scroll(direction: 'down' | 'up'): Promise<ActResult>;
  back(): Promise<ActResult>;
  dialog(action: 'accept' | 'dismiss'): Promise<ActResult>;
  screenshot(name: string): Promise<string | undefined>;
  now(): number;
  sleep(ms: number): Promise<void>;
  row(row: LedgerRow): void;
}

export const WAIT_BUDGET_MS = 15_000;
export const WAIT_POLL_MS = 500;
export const SCROLL_ATTEMPTS = 6;

export interface WalkOutcome {
  block: BlockResult;
  rows: LedgerRow[];
  failure?: LedgerFailure;
  refusal?: { code: string; message: string };
}

function seenOn(screen: Screen): string {
  return screen.visibleText.slice(0, 40).join(' | ');
}

// Retry a mutation once only when read-back failed and the screen provably did not move.
export async function walkBlock(
  block: Block,
  deps: WalkerDeps,
  shotIndex = 0,
  typed: string[] = [],
  privacy = new ObservedPrivacy(typed),
): Promise<WalkOutcome> {
  const rows: LedgerRow[] = [];
  for (const item of block.items)
    if (item.kind === 'fill' && !typed.includes(item.text)) typed.push(item.text);
  const judge = deps.judge ?? unavailableJudge;
  let resolvedBy: LedgerRow['resolvedBy'] = 'exact';
  let cached: { item: Item; screen: Screen; decision: ScreenDecision } | undefined;
  let latest: Screen = { elements: [], visibleText: [], front: 'app' };
  const capture = async (): Promise<Screen> => {
    cached = undefined;
    latest = await deps.captureScreen();
    privacy.observe(latest);
    return latest;
  };
  const decide = (
    screen: Screen,
    check?: Item & { kind: 'check' },
    step?: Exclude<Item, { kind: 'check' }>,
  ): Promise<ScreenDecision> => decideScreen(screen, judge, check, step, privacy.modelValues());
  let shots = shotIndex;
  const emit = (row: LedgerRow): void => {
    rows.push(row);
    deps.row(row);
  };
  const redact = (text: string): string => privacy.redact(text);
  const base = (item: Item, attempt: number): Omit<LedgerRow, 'outcome'> => ({
    block: block.slug,
    line: item.line,
    text: redact(item.raw),
    attempt,
    kind: item.kind === 'check' ? 'check' : 'step',
    resolvedBy,
    t: deps.now(),
  });
  const failed = (
    item: Item,
    attempt: number,
    reason: string,
    screen: Screen,
    screenshot: string | undefined,
    ref?: string,
  ): WalkOutcome => {
    emit({
      ...base(item, attempt),
      ...(ref ? { ref } : {}),
      ...(screenshot ? { screenshot } : {}),
      outcome: 'fail',
      reason: redact(reason),
    });
    return {
      block: { key: block.slug, outcome: 'fail', source: 'discovered' },
      rows,
      failure: {
        step: item.line,
        seen: redact(maskInputs(screen, `${reason}; on screen: ${seenOn(screen)}`, typed)),
        ...(screenshot ? { screenshot } : {}),
      },
    };
  };
  const shoot = async (item: Item): Promise<string | undefined> => {
    shots += 1;
    return deps.screenshot(screenshotName(shots, item.line));
  };

  for (const item of block.items) {
    resolvedBy = item.source === 'jev' ? 'jev' : 'exact';
    if (item.kind === 'fill' && item.text && !typed.includes(item.text)) typed.push(item.text);
    try {
      if (item.kind === 'check') {
        let before = await capture();
        const next = block.items[block.items.indexOf(item) + 1];
        const nextStep = !item.literal && next && next.kind !== 'check' ? next : undefined;
        resolvedBy = item.literal ? 'exact' : 'jev';
        let decision = await decide(before, item, nextStep);
        for (let reask = 0; decision.check === 'unsure' && reask < CHECK.reasks; reask++) {
          await deps.sleep(WAIT_POLL_MS);
          before = await capture();
          decision = await decide(before, item, nextStep);
        }
        const shot = await shoot(item);
        if (decision.check === 'pass') {
          if (nextStep) cached = { item: nextStep, screen: before, decision };
          emit({ ...base(item, 1), ...(shot ? { screenshot: shot } : {}), outcome: 'pass' });
          continue;
        }
        const reason =
          decision.check === 'unsure'
            ? 'CHECK_UNSURE: the expectation remained uncertain after a fresh-screen re-ask'
            : `"${item.text}" is not satisfied on screen`;
        return failed(item, 1, reason, before, shot);
      }

      if (item.kind === 'wait') {
        resolvedBy = item.target.quoted === undefined ? 'jev' : resolvedBy;
        const deadline = deps.now() + WAIT_BUDGET_MS;
        const held = cached?.item === item ? cached : undefined;
        let screen = held?.screen ?? (await capture());
        cached = undefined;
        const visible = async (s: Screen, initial?: ScreenDecision): Promise<boolean> => {
          if (item.target.quoted !== undefined) return targetVisible(item.target, s);
          const decision = initial ?? (await decide(s, undefined, item));
          return resolutionVisible(decision.target);
        };
        let found = await visible(screen, held?.decision);
        while (!found && deps.now() < deadline) {
          await deps.sleep(WAIT_POLL_MS);
          screen = await capture();
          found = await visible(screen);
        }
        const shot = await shoot(item);
        if (found) {
          emit({ ...base(item, 1), ...(shot ? { screenshot: shot } : {}), outcome: 'pass' });
          continue;
        }
        const reason = `"${item.target.phrase}" did not appear within ${WAIT_BUDGET_MS / 1000}s`;
        return failed(item, 1, reason, screen, shot);
      }

      if (item.kind === 'scroll' && item.until) {
        resolvedBy = item.until.quoted === undefined ? 'jev' : resolvedBy;
        const held = cached?.item === item ? cached : undefined;
        let screen = held?.screen ?? (await capture());
        cached = undefined;
        const visible = async (s: Screen, initial?: ScreenDecision): Promise<boolean> => {
          if (item.until!.quoted !== undefined) return targetVisible(item.until!, s);
          const decision = initial ?? (await decide(s, undefined, item));
          return resolutionVisible(decision.target);
        };
        let found = await visible(screen, held?.decision);
        let attempts = 0;
        while (!found && attempts < SCROLL_ATTEMPTS) {
          attempts += 1;
          const act = await deps.scroll(item.direction);
          const next = await capture();
          const moved = screenSignature(next) !== screenSignature(screen);
          screen = next;
          found = await visible(screen);
          if (!act.ok && !moved)
            return failed(
              item,
              attempts,
              act.error ?? 'scroll was not dispatched',
              screen,
              await shoot(item),
            );
        }
        const shot = await shoot(item);
        if (found) {
          emit({
            ...base(item, Math.max(attempts, 1)),
            ...(shot ? { screenshot: shot } : {}),
            outcome: 'pass',
          });
          continue;
        }
        const reason = `"${item.until.phrase}" did not come into view after ${SCROLL_ATTEMPTS} scrolls`;
        return failed(item, Math.max(attempts, 1), reason, screen, shot);
      }

      // press · fill · back · dialog: snapshot → resolve → act → read-back → snapshot → diff rule
      let outcome: WalkOutcome | undefined;
      for (let attempt = 1; attempt <= 2 && !outcome; attempt += 1) {
        const held = cached?.item === item ? cached : undefined;
        let before = held?.screen ?? (await capture());
        cached = undefined;
        let ref: string | undefined;
        if (item.kind === 'press' || item.kind === 'fill') {
          if (item.target.quoted === undefined) resolvedBy = 'jev';
          let decision = held?.decision ?? (await decide(before, undefined, item));
          resolvedBy = decision.resolvedBy === 'jev' ? 'jev' : resolvedBy;
          let resolution = decision.target!;
          let scrollError: string | undefined;
          if ('scroll' in resolution) {
            const act = await deps.scroll(resolution.scroll);
            scrollError = act.ok ? undefined : (act.error ?? 'scroll was not dispatched');
            before = await capture();
            decision = await decide(before, undefined, item);
            resolvedBy = decision.resolvedBy === 'jev' ? 'jev' : resolvedBy;
            resolution = decision.target!;
          }
          if ('refuse' in resolution) {
            outcome = failed(
              item,
              attempt,
              `${resolution.refuse}: ${resolution.reason}`,
              before,
              await shoot(item),
            );
            break;
          }
          if ('scroll' in resolution) {
            outcome = failed(
              item,
              attempt,
              scrollError
                ? `${scrollError}; "${item.target.phrase}" stayed off screen after one scroll`
                : `"${item.target.phrase}" stayed off screen after one scroll`,
              before,
              await shoot(item),
            );
            break;
          }
          ref = resolution.ref;
        }
        const act =
          item.kind === 'press'
            ? await deps.press(ref!)
            : item.kind === 'fill'
              ? await deps.fill(ref!, item.text)
              : item.kind === 'scroll'
                ? await deps.scroll(item.direction)
                : item.kind === 'back'
                  ? await deps.back()
                  : await deps.dialog(item.action);
        const after = await capture();
        const shot = await shoot(item);
        // NOTE: a not-ok result is not a verdict; an act that timed out may still have landed.
        const changed = screenSignature(after) !== screenSignature(before);
        if (act.proven || changed) {
          emit({
            ...base(item, attempt),
            ...(ref ? { ref } : {}),
            ...(shot ? { screenshot: shot } : {}),
            outcome: 'pass',
          });
          break;
        }
        if (attempt === 1) {
          emit({
            ...base(item, attempt),
            ...(ref ? { ref } : {}),
            ...(shot ? { screenshot: shot } : {}),
            outcome: 'retry',
            reason: redact(
              act.error
                ? `${act.error}; the screen did not change; retrying once`
                : 'the screen did not change; retrying once',
            ),
          });
          continue;
        }
        outcome = failed(
          item,
          attempt,
          act.error
            ? `${act.error}; the screen did not change after two attempts`
            : 'the screen did not change after two attempts',
          after,
          shot,
          ref,
        );
      }
      if (outcome) return outcome;
    } catch (error) {
      if (!(error instanceof JevError) && !(error instanceof ResolutionError)) throw error;
      if (error instanceof JevError) resolvedBy = 'jev';
      const refusal =
        error instanceof JevError && error.isRefusal
          ? { code: error.code, message: error.message }
          : undefined;
      const shot = refusal ? await shoot(item).catch(() => undefined) : await shoot(item);
      return { ...failed(item, 1, error.message, latest, shot), ...(refusal ? { refusal } : {}) };
    }
  }
  return { block: { key: block.slug, outcome: 'pass', source: 'discovered' }, rows };
}

export async function runPlan(
  blocks: Block[],
  deps: WalkerDeps,
  preflightCalls: readonly JevCall[] = [],
): Promise<WalkResult> {
  const results: BlockResult[] = [];
  const steps: LedgerRow[] = [];
  const typed = blocks.flatMap((b) => b.items.flatMap((i) => (i.kind === 'fill' ? [i.text] : [])));
  const privacy = new ObservedPrivacy(typed);
  const calls = (): JevCall[] => [...preflightCalls, ...(deps.judge?.calls ?? [])];
  for (const block of blocks) {
    const outcome = await walkBlock(block, deps, steps.length, typed, privacy);
    results.push(outcome.block);
    steps.push(...outcome.rows);
    if (outcome.failure) {
      const ledger = buildLedger(results, steps, outcome.failure, calls());
      return outcome.refusal ? { ...ledger, ...outcome.refusal, verdict: 'REFUSED' } : ledger;
    }
  }
  return buildLedger(results, steps, undefined, calls());
}
