import { cwdForPort, pathMatchesRoot } from '../cdp/metro-cwd.js';
import { readProcessBirth, type ProcessBirth } from './process-birth.js';

export interface MetroBinding {
  port: number;
  pid: number;
  birth: string;
  instanceId: string;
  servingRoot: string;
  buildGeneration: number;
}

interface MetroBindingDependencies {
  readBirth?: (pid: number) => ProcessBirth | null;
  fetchStatus?: (port: number) => Promise<string>;
  servingRoot?: (port: number) => string | null;
}

async function fetchMetroStatus(port: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function captureMetroBinding(
  input: {
    port: number;
    pid: number;
    instanceId: string;
    sourceRoot: string;
    buildGeneration: number;
  },
  dependencies: MetroBindingDependencies = {},
): Promise<MetroBinding> {
  if (
    !Number.isSafeInteger(input.port) ||
    input.port < 1 ||
    input.port > 65_535 ||
    !Number.isSafeInteger(input.pid) ||
    input.pid < 1 ||
    !input.instanceId ||
    !Number.isSafeInteger(input.buildGeneration) ||
    input.buildGeneration < 1
  ) {
    throw new Error('METRO_AUTHORITY_MISMATCH: Metro binding is incomplete');
  }
  const birth = (dependencies.readBirth ?? readProcessBirth)(input.pid);
  if (!birth) {
    throw new Error(
      'PROCESS_BIRTH_UNAVAILABLE: Metro process birth could not be proven conservatively',
    );
  }
  const status = await (dependencies.fetchStatus ?? fetchMetroStatus)(input.port);
  if (!status.includes('packager-status:running')) {
    throw new Error('METRO_AUTHORITY_MISMATCH: claimed Metro endpoint is not running');
  }
  const servingRoot = (dependencies.servingRoot ?? cwdForPort)(input.port);
  if (!servingRoot || !pathMatchesRoot(servingRoot, input.sourceRoot)) {
    throw new Error(
      'METRO_AUTHORITY_MISMATCH: Metro serving root does not match the source worktree',
    );
  }
  return {
    port: input.port,
    pid: input.pid,
    birth: birth.token,
    instanceId: input.instanceId,
    servingRoot,
    buildGeneration: input.buildGeneration,
  };
}
