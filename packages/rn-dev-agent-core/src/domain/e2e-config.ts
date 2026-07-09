import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface E2eConfig {
  defaults?: { params?: Record<string, string> };
  tests?: Record<string, { params?: Record<string, string> }>;
  secretParams?: string[];
}

export function loadE2eConfig(projectRoot: string): E2eConfig {
  const filePath = join(projectRoot, '.rn-agent', 'e2e.config.json');
  try {
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as E2eConfig;
  } catch {
    return {};
  }
}

export function resolveParams(
  config: E2eConfig,
  testId: string,
  required: string[],
  provided?: Record<string, string>,
): { ok: true; params: Record<string, string> } | { ok: false; missing: string[] } {
  // Caller-provided values (e.g. typed into the observe UI) take precedence
  // over config; empty strings are treated as "not provided" so a blank input
  // never masks a configured value.
  const overrides = Object.fromEntries(
    Object.entries(provided ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''),
  );
  const merged: Record<string, string> = {
    ...config.defaults?.params,
    ...config.tests?.[testId]?.params,
    ...overrides,
  };
  const missing = required.filter((k) => !merged[k]);
  if (missing.length > 0) return { ok: false, missing };
  // Return ONLY the params the action declares — never leak unrelated
  // defaults (which may include secrets) into a test that doesn't use them.
  const params: Record<string, string> = {};
  for (const k of required) params[k] = merged[k] as string;
  return { ok: true, params };
}

export function secretValuesFor(config: E2eConfig, params: Record<string, string>): string[] {
  const names = new Set(config.secretParams ?? []);
  return Object.entries(params)
    .filter(([k, v]) => names.has(k) && v !== '')
    .map(([, v]) => v);
}

export function redactSecrets(text: string, secretValues: string[]): string {
  const active = secretValues.filter((s) => s !== '');
  if (active.length === 0) return text;
  let result = text;
  for (const secret of active) {
    result = result.split(secret).join('***');
  }
  return result;
}
