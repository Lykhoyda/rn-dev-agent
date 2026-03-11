import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertGreaterThan } from '../lib/assertions.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function errorLogSuite(client: McpTestClient): Promise<string> {
  await client.callTool('cdp_error_log', { clear: true });

  await client.callTool('cdp_evaluate', {
    expression: 'setTimeout(() => { throw new Error("harness-test-error"); }, 0)',
  });
  await sleep(500);

  const result = await client.callTool('cdp_error_log');
  assertTruthy(!result.isError, 'error_log returned error');

  const data = McpTestClient.parseResult(result) as Record<string, unknown>;
  assertGreaterThan(data.count as number, 0, 'error count');

  const errors = data.errors as Array<Record<string, unknown>>;
  const testError = errors.find((e) => (e.message as string)?.includes('harness-test-error'));
  assertTruthy(testError, 'harness-test-error found in error log');

  return 'error captured in buffer';
}
