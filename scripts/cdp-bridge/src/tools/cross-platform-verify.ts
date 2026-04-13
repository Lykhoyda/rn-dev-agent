import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, extname } from 'node:path';
import { getCachedSnapshot } from '../agent-device-wrapper.js';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';

interface VerifyArgs {
  elements?: string[];
  scanDir?: string;
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

const TESTID_RE = /testID\s*=\s*(?:"([^"]+)"|'([^']+)'|\{["']([^"']+)["']\})/g;
const SCAN_EXTENSIONS = new Set(['.tsx', '.jsx', '.ts', '.js']);

export function discoverTestIDs(dir: string): string[] {
  const ids = new Set<string>();

  function walk(d: string): void {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(d, entry);
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { walk(full); continue; }
        if (!SCAN_EXTENSIONS.has(extname(entry))) continue;
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(TESTID_RE)) {
          const id = m[1] ?? m[2] ?? m[3];
          if (id) ids.add(id);
        }
      } catch { /* skip unreadable files */ }
    }
  }

  walk(dir);
  return [...ids].sort();
}

export function createCrossPlatformVerifyHandler(): (args: VerifyArgs) => Promise<ToolResult> {
  return async (args) => {
    let elements = args.elements;

    let discoveredCount = 0;
    if (args.scanDir) {
      const discovered = discoverTestIDs(args.scanDir);
      if (discovered.length === 0) {
        return failResult(
          `No testIDs found in ${args.scanDir}. Ensure components use testID="..." props.`,
        );
      }
      discoveredCount = discovered.length;
      elements = elements ? [...new Set([...elements, ...discovered])] : discovered;
    }

    if (!elements || elements.length === 0) {
      return failResult('Provide elements[] or scanDir to discover testIDs from source.');
    }

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

    for (const el of elements) {
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
    const total = elements.length;
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
      ...(args.scanDir ? { scannedDir: args.scanDir, discoveredTestIDs: discoveredCount } : {}),
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
