import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { ReplayEngineStatus } from './engine-pin.js';
import {
  classifyLearnedActionPath,
  isLearnedActionPath,
  replayCompatibilityPreflight,
  standaloneLearnedActionPathRefusal,
} from './action-engine-compat.js';
import {
  captureActionFromContext,
  openReadableActionLoadContext,
  type ReadableActionLoadContext,
} from './action-store.js';
import { parseAndValidateFlow } from './maestro-validator.js';
import { parseM7Header, type M7Metadata } from './reusable-action.js';
import { learnedActionEntryRefusal } from './park-entry.js';

export interface PreparedActionVerificationFlow {
  file: string;
  inlineYaml: string;
  actionMetadata?: Pick<M7Metadata, 'id' | 'enginePin' | 'entry'>;
}

export interface ActionVerificationPreflightError {
  file: string;
  error: string;
  code?: 'BAD_RECORDING';
  cause?: { invalidEntry: string };
}

export function prepareActionVerificationSuite(
  files: readonly string[],
  flowDir: string,
  engineStatus: ReplayEngineStatus | null,
  context?: ReadableActionLoadContext,
): {
  prepared: PreparedActionVerificationFlow[];
  errors: ActionVerificationPreflightError[];
} {
  const prepared: PreparedActionVerificationFlow[] = [];
  const errors: ActionVerificationPreflightError[] = [];
  const learnedCorpus = classifyLearnedActionPath(resolve(flowDir, '__action__.yaml')) === 'action';
  let learnedContext = context;
  if (learnedCorpus && !learnedContext) {
    try {
      learnedContext =
        openReadableActionLoadContext(dirname(dirname(resolve(flowDir))), {
          includeRunFlowFiles: true,
        }) ?? undefined;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { prepared, errors: files.map((file) => ({ file, error })) };
    }
  }
  for (const file of files) {
    try {
      const id = basename(file).replace(/\.ya?ml$/i, '');
      const owned = isLearnedActionPath(file);
      let inlineYaml: string;
      let commands: unknown[];
      let meta: ReturnType<typeof parseM7Header>;
      let actionReplay: ReturnType<typeof captureActionFromContext> = null;
      let sourceText: string;
      if (learnedContext) {
        const action = captureActionFromContext(learnedContext, id);
        if (!action || basename(action.filePath) !== basename(file)) {
          throw new Error(`Action ${id} did not resolve to ${file}`);
        }
        actionReplay = action;
        sourceText = action.yamlText;
        meta = action.metadata;
      } else {
        const actionPathRefusal = standaloneLearnedActionPathRefusal(file);
        if (actionPathRefusal) throw new Error(actionPathRefusal);
        sourceText = readFileSync(file, 'utf8');
        meta = parseM7Header(sourceText, id);
      }
      const entryRefusal = meta ? learnedActionEntryRefusal(meta, false) : null;
      if (entryRefusal) {
        errors.push({
          file,
          error: entryRefusal.message,
          code: 'BAD_RECORDING',
          ...(entryRefusal.kind === 'invalid-entry'
            ? { cause: { invalidEntry: entryRefusal.raw } }
            : {}),
        });
        continue;
      }
      if (actionReplay) {
        if (!actionReplay.replay.ok) throw new Error(actionReplay.replay.error);
        inlineYaml = actionReplay.replay.yamlText;
        commands = actionReplay.replay.commands;
      } else {
        const parsed = parseAndValidateFlow(sourceText, {
          flowDir: dirname(file),
          flowRoot: flowDir,
        });
        inlineYaml = parsed.raw;
        commands = parsed.commands;
      }
      const refusal = replayCompatibilityPreflight({
        enginePin: meta?.enginePin,
        commands,
        engineStatus,
        requireEnginePin: meta !== null || owned,
      });
      if (refusal) throw new Error(refusal);
      prepared.push({
        file,
        inlineYaml,
        ...(meta ? { actionMetadata: meta } : {}),
      });
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { prepared, errors };
}
