import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertCheck(receipt: unknown, ledger: unknown, requireJevWalk: boolean): void {
  const r = receipt as { result?: string; ledger?: { verdict?: string } } | undefined;
  const l = ledger as
    | {
        verdict?: string;
        llmTurns?: number;
        escapes?: number;
        recoveries?: number;
        jev?: { calls?: number; callDetails?: { scope: string; outcome: string }[] };
        steps?: { resolvedBy: string }[];
      }
    | undefined;
  if (r?.result !== 'pass' || r?.ledger?.verdict !== 'PASS' || l?.verdict !== 'PASS')
    throw new Error('receipt and ledger must both say PASS');
  if (l.llmTurns !== 0 || l.escapes !== 0 || l.recoveries !== 0)
    throw new Error('the phase gate must not use recovery or an escape');
  if (
    requireJevWalk &&
    (!((l.jev?.calls ?? 0) > 0) ||
      !l.jev?.callDetails?.some((c) => c.scope === 'walk' && c.outcome === 'ok') ||
      !l.steps?.some((s) => s.resolvedBy === 'jev'))
  )
    throw new Error(
      'phrase gate needs a successful walk judgment; preflight alone is insufficient',
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = JSON.parse(readFileSync(0, 'utf8'));
    const ledger = JSON.parse(readFileSync(receipt.artifacts.ledger, 'utf8'));
    assertCheck(receipt, ledger, process.env.QAREN_REQUIRE_JEV_WALK === '1');
    console.log(
      `gate:qaren-check: PASS steps=${receipt.ledger.steps} jev.calls=${ledger.jev.calls} report=${receipt.artifacts.report}`,
    );
  } catch {
    console.error('gate:qaren-check: receipt or ledger did not meet the phase gate');
    process.exitCode = 1;
  }
}
