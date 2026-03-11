import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertShape, assertEqual } from '../lib/assertions.js';

export async function evaluateSuite(client: McpTestClient): Promise<string> {
  const infoResult = await client.callTool('cdp_evaluate', {
    expression: '__RN_AGENT.getAppInfo()',
  });
  assertTruthy(!infoResult.isError, 'getAppInfo returned error');
  const infoText = (infoResult.content[0] as { text: string }).text;
  const info = JSON.parse(infoText) as Record<string, unknown>;
  assertShape(info, ['platform', 'hermes', '__DEV__'], 'appInfo shape');
  assertEqual(info.hermes, true, 'hermes enabled');
  assertEqual(info.__DEV__, true, 'dev mode');

  const navResult = await client.callTool('cdp_evaluate', {
    expression: 'typeof globalThis.__NAV_REF__',
  });
  assertTruthy(!navResult.isError, '__NAV_REF__ check error');
  const navType = (navResult.content[0] as { text: string }).text;
  assertEqual(navType, 'object', '__NAV_REF__ type');

  const storeResult = await client.callTool('cdp_evaluate', {
    expression: 'typeof globalThis.__REDUX_STORE__',
  });
  assertTruthy(!storeResult.isError, '__REDUX_STORE__ check error');
  const storeType = (storeResult.content[0] as { text: string }).text;
  assertEqual(storeType, 'object', '__REDUX_STORE__ type');

  return 'getAppInfo valid, globals accessible';
}
