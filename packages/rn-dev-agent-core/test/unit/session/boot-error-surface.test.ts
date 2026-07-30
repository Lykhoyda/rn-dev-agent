import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { createMockClient } from '../../helpers/mock-cdp-client.js';
import { createBootErrorCaptureModule } from '../../../dist/session/metro-authority.js';
import { createErrorLogHandler } from '../../../dist/tools/error-log.js';
import { createStatusHandler } from '../../../dist/tools/status.js';

function envelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

test('fatal pre-helper boot errors reach cdp_status and cdp_error_log', async () => {
  let globalHandler: (error: Error, isFatal: boolean) => void = () => {};
  const context = createContext({
    ErrorUtils: {
      getGlobalHandler: () => globalHandler,
      setGlobalHandler: (next: typeof globalHandler) => {
        globalHandler = next;
      },
    },
  });
  runInContext(createBootErrorCaptureModule(), context);
  runInContext(
    'ErrorUtils.getGlobalHandler()(new Error("fatal before helper injection"), true)',
    context,
  );
  const client = createMockClient({
    _helpersInjected: false,
    _metroPort: 39137,
    _connectedTarget: {
      id: 'fatal-boot-target',
      title: 'Fatal boot fixture',
      vm: 'Hermes',
      description: 'com.rndevagent.fatalboot',
      platform: 'ios',
      webSocketDebuggerUrl: 'ws://127.0.0.1:39137/fatal-boot-target',
    },
    evaluate: async (expression: string) => {
      try {
        return { value: runInContext(expression, context) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  const statusResult = await createStatusHandler(
    () => client,
    () => {},
    () => client,
  )({});
  const errorResult = await createErrorLogHandler(() => client)({ clear: false });
  const status = envelope(statusResult);
  const errors = envelope(errorResult);

  assert.equal(status.ok, true, statusResult.content[0]!.text);
  assert.equal(status.data.app.bootErrorCount, 1);
  assert.equal(status.data.app.hasRedBox, true);
  assert.equal(errors.ok, true, errorResult.content[0]!.text);
  assert.equal(errors.data.count, 1);
  assert.equal(errors.data.errors[0].message, 'fatal before helper injection');
  assert.equal(errors.data.errors[0].isFatal, true);
  assert.equal(errors.data.errors[0].type, 'startup');
});
