import type { Block, Item } from './plan.js';
import { type Screen, assertionView, screenSignature } from './screen.js';
import { judgeCheck, resolveTarget, targetVisible } from './resolve.js';
import {
  type BlockResult,
  type Ledger,
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
}

function seenOn(screen: Screen): string {
  return assertionView(screen).slice(0, 40).join(' | ');
}

// What was typed never reaches the ledger: every quoted span equal to a value is masked in
// either quote style, and a value of three or more characters is masked wherever it appears.
const MASK = '•••';
const MASK_EMBEDDED_MIN = 3;

function maskValue(text: string, value: string): string {
  let masked = text;
  for (const [open, close] of [
    ['"', '"'],
    ['“', '”'],
  ]) {
    masked = masked.split(`${open}${value}${close}`).join(`${open}${MASK}${close}`);
  }
  return value.length >= MASK_EMBEDDED_MIN ? masked.split(value).join(MASK) : masked;
}

function phraseTargetReason(phrase: string): string {
  return `"${phrase}" is not quoted; phrase targets arrive with Jev in a later phase`;
}

// One block, one sequential loop. A tap is never repeated on a timeout alone:
// an act is retried once only when the screen provably did not move.
// `typed` collects every value a fill typed during the run; nothing emitted afterwards
// (row text, reasons, evidence) carries any of them, across block boundaries.
export async function walkBlock(
  block: Block,
  deps: WalkerDeps,
  shotIndex = 0,
  typed: string[] = [],
): Promise<WalkOutcome> {
  const rows: LedgerRow[] = [];
  let shots = shotIndex;
  const emit = (row: LedgerRow): void => {
    rows.push(row);
    deps.row(row);
  };
  // Longer values first, so a value that is a prefix of another cannot expose its remainder.
  const redact = (text: string): string =>
    [...typed]
      .sort((a, b) => b.length - a.length)
      .reduce((masked, value) => maskValue(masked, value), text);
  // An input showing a typed value is masked as the screen renders it (`label: value`), whatever the length.
  const redactInputs = (screen: Screen, text: string): string =>
    screen.elements.reduce(
      (masked, el) =>
        el.kind === 'input' && el.label && el.value && typed.includes(el.value)
          ? masked.split(`${el.label}: ${el.value}`).join(`${el.label}: ${MASK}`)
          : masked,
      text,
    );
  const base = (item: Item, attempt: number): Omit<LedgerRow, 'outcome'> => ({
    block: block.slug,
    line: item.line,
    text: redact(item.raw),
    attempt,
    kind: item.kind === 'check' ? 'check' : 'step',
    resolvedBy: 'exact',
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
        seen: redact(redactInputs(screen, `${reason}; on screen: ${seenOn(screen)}`)),
        ...(screenshot ? { screenshot } : {}),
      },
    };
  };
  const shoot = async (item: Item): Promise<string | undefined> => {
    shots += 1;
    return deps.screenshot(screenshotName(shots, item.line));
  };

  for (const item of block.items) {
    if (item.kind === 'fill' && item.text && !typed.includes(item.text)) typed.push(item.text);
    if (item.kind === 'check') {
      const before = await deps.captureScreen();
      const verdict = judgeCheck(item, before);
      const shot = await shoot(item);
      if (verdict === 'pass') {
        emit({ ...base(item, 1), ...(shot ? { screenshot: shot } : {}), outcome: 'pass' });
        continue;
      }
      const reason =
        verdict === 'unsure'
          ? `✓ "${item.text}" has no quoted phrase; phrase checks arrive with Jev in a later phase`
          : `"${item.text}" is not on screen`;
      return failed(item, 1, reason, before, shot);
    }

    if (item.kind === 'wait') {
      if (item.target.quoted === undefined) {
        const screen = await deps.captureScreen();
        return failed(item, 1, phraseTargetReason(item.target.phrase), screen, await shoot(item));
      }
      const deadline = deps.now() + WAIT_BUDGET_MS;
      let screen = await deps.captureScreen();
      while (!targetVisible(item.target, screen) && deps.now() < deadline) {
        await deps.sleep(WAIT_POLL_MS);
        screen = await deps.captureScreen();
      }
      const shot = await shoot(item);
      if (targetVisible(item.target, screen)) {
        emit({ ...base(item, 1), ...(shot ? { screenshot: shot } : {}), outcome: 'pass' });
        continue;
      }
      const reason = `"${item.target.quoted}" did not appear within ${WAIT_BUDGET_MS / 1000}s`;
      return failed(item, 1, reason, screen, shot);
    }

    if (item.kind === 'scroll' && item.until) {
      let screen = await deps.captureScreen();
      if (item.until.quoted === undefined) {
        return failed(item, 1, phraseTargetReason(item.until.phrase), screen, await shoot(item));
      }
      let attempts = 0;
      while (!targetVisible(item.until, screen) && attempts < SCROLL_ATTEMPTS) {
        attempts += 1;
        const act = await deps.scroll(item.direction);
        const next = await deps.captureScreen();
        const moved = screenSignature(next) !== screenSignature(screen);
        screen = next;
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
      if (targetVisible(item.until, screen)) {
        emit({
          ...base(item, Math.max(attempts, 1)),
          ...(shot ? { screenshot: shot } : {}),
          outcome: 'pass',
        });
        continue;
      }
      const reason = `"${item.until.quoted}" did not come into view after ${SCROLL_ATTEMPTS} scrolls`;
      return failed(item, Math.max(attempts, 1), reason, screen, shot);
    }

    // press · fill · back · dialog: snapshot → resolve → act → read-back → snapshot → diff rule
    let outcome: WalkOutcome | undefined;
    for (let attempt = 1; attempt <= 2 && !outcome; attempt += 1) {
      let before = await deps.captureScreen();
      let ref: string | undefined;
      if (item.kind === 'press' || item.kind === 'fill') {
        let resolution = resolveTarget(item, before);
        let scrollError: string | undefined;
        if ('scroll' in resolution) {
          const act = await deps.scroll(resolution.scroll);
          scrollError = act.ok ? undefined : (act.error ?? 'scroll was not dispatched');
          before = await deps.captureScreen();
          resolution = resolveTarget(item, before);
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
              ? `${scrollError}; "${item.target.quoted}" stayed off screen after one scroll`
              : `"${item.target.quoted}" stayed off screen after one scroll`,
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
      const after = await deps.captureScreen();
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
  }
  return { block: { key: block.slug, outcome: 'pass', source: 'discovered' }, rows };
}

export async function runPlan(blocks: Block[], deps: WalkerDeps): Promise<Ledger> {
  const results: BlockResult[] = [];
  const steps: LedgerRow[] = [];
  const typed: string[] = [];
  for (const block of blocks) {
    const outcome = await walkBlock(block, deps, steps.length, typed);
    results.push(outcome.block);
    steps.push(...outcome.rows);
    if (outcome.failure) return buildLedger(results, steps, outcome.failure);
  }
  return buildLedger(results, steps);
}
