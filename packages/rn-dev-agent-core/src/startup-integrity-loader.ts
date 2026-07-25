import { instrumentStartupSource } from './startup-integrity.js';

interface LoaderContext {
  format?: string | null;
  [key: string]: unknown;
}

interface LoaderResult {
  format: string;
  source?: string | ArrayBuffer | ArrayBufferView | null;
  shortCircuit?: boolean;
  [key: string]: unknown;
}

type NextLoad = (url: string, context: LoaderContext) => Promise<LoaderResult>;

let entrypointUrl: string | null = null;

export function initialize(data: unknown): void {
  const value = data as { entrypointUrl?: unknown } | null;
  if (!value || typeof value.entrypointUrl !== 'string' || !value.entrypointUrl.startsWith('file:')) {
    throw new Error('STARTUP_INTEGRITY_UNAVAILABLE: worker entrypoint URL is invalid');
  }
  entrypointUrl = value.entrypointUrl;
}

export async function load(
  url: string,
  context: LoaderContext,
  nextLoad: NextLoad,
): Promise<LoaderResult> {
  const result = await nextLoad(url, context);
  if (url !== entrypointUrl) return result;
  if (result.source === null || result.source === undefined || result.format !== 'module') {
    throw new Error('STARTUP_INTEGRITY_UNAVAILABLE: worker entrypoint source is unavailable');
  }
  const instrumented = instrumentStartupSource(url, result.source);
  return {
    ...result,
    source: instrumented.source,
    shortCircuit: true,
  };
}
