import { getCachedSnapshot } from '../agent-device-wrapper.js';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';

interface VerifyArgs {
  elements: string[];
  matchBy?: 'testID' | 'label' | 'any';
}

interface ElementResult {
  element: string;
  ios: 'FOUND' | 'MISSING' | 'NO_SNAPSHOT';
  android: 'FOUND' | 'MISSING' | 'NO_SNAPSHOT';
  match: boolean;
}

export function findElement(
  nodes: { ref: string; label?: string; identifier?: string; type?: string }[],
  query: string,
  matchBy: 'testID' | 'label' | 'any',
): boolean {
  const q = query.toLowerCase();
  return nodes.some((n) => {
    if (matchBy === 'testID') return n.identifier?.toLowerCase() === q;
    if (matchBy === 'label') return n.label?.toLowerCase().includes(q) ?? false;
    return (n.identifier?.toLowerCase() === q) || (n.label?.toLowerCase().includes(q) ?? false);
  });
}

export function createCrossPlatformVerifyHandler(): (args: VerifyArgs) => Promise<ToolResult> {
  return async (args) => {
    const matchBy = args.matchBy ?? 'any';
    const iosSnap = getCachedSnapshot('ios');
    const androidSnap = getCachedSnapshot('android');

    if (!iosSnap && !androidSnap) {
      return failResult(
        'No cached snapshots for either platform. Run device_snapshot on iOS and Android first, ' +
        'then call this tool to compare.',
        { hint: 'Workflow: open iOS session → device_snapshot → switch to Android → device_snapshot → cross_platform_verify' },
      );
    }

    const results: ElementResult[] = [];
    let iosFound = 0;
    let androidFound = 0;

    for (const el of args.elements) {
      const iosStatus: ElementResult['ios'] = !iosSnap ? 'NO_SNAPSHOT' : findElement(iosSnap.nodes, el, matchBy) ? 'FOUND' : 'MISSING';
      const androidStatus: ElementResult['android'] = !androidSnap ? 'NO_SNAPSHOT' : findElement(androidSnap.nodes, el, matchBy) ? 'FOUND' : 'MISSING';

      if (iosStatus === 'FOUND') iosFound++;
      if (androidStatus === 'FOUND') androidFound++;

      results.push({
        element: el,
        ios: iosStatus,
        android: androidStatus,
        match: iosStatus === 'FOUND' && androidStatus === 'FOUND',
      });
    }

    const missing = results.filter(r => !r.match || r.ios === 'MISSING' || r.android === 'MISSING');
    const total = args.elements.length;
    const allMatch = missing.length === 0 && iosSnap != null && androidSnap != null;

    const summary = {
      verdict: allMatch ? 'PASS' : 'FAIL',
      total,
      iosFound,
      androidFound,
      missingCount: missing.length,
      iosCapturedAt: iosSnap?.capturedAt ?? null,
      androidCapturedAt: androidSnap?.capturedAt ?? null,
      matchBy,
      results,
    };

    if (!iosSnap || !androidSnap) {
      const missingPlatform = !iosSnap ? 'ios' : 'android';
      return warnResult(summary, `No snapshot cached for ${missingPlatform}. Run device_snapshot on ${missingPlatform} first for a complete comparison.`);
    }

    if (!allMatch) {
      const missingLines = missing.map(
        m => `  ${m.element}: iOS=${m.ios}, Android=${m.android}`,
      ).join('\n');
      return warnResult(summary, `Cross-platform verification FAILED — ${missing.length}/${total} elements differ:\n${missingLines}`);
    }

    return okResult(summary);
  };
}
