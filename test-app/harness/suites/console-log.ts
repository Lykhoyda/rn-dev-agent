import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertGreaterThan } from '../lib/assertions.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function consoleLogSuite(client: McpTestClient): Promise<string> {
  await client.callTool('cdp_console_log', { clear: true });

  await client.callTool('cdp_evaluate', {
    expression: '__NAV_REF__.navigate("Tabs", { screen: "NotificationsTab" })',
  });
  await sleep(1000);

  const result = await client.callTool('cdp_console_log', { level: 'all', limit: 50 });
  assertTruthy(!result.isError, 'console_log returned error');

  const data = McpTestClient.parseResult(result) as Record<string, unknown>;
  assertGreaterThan(data.count as number, 0, 'console entries count');

  const entries = data.entries as Array<Record<string, string>>;

  const hasInfo = entries.some((e) => e.text?.includes('notifications loaded'));
  const hasWarn = entries.some((e) => e.text?.includes('stale cache'));
  const hasError = entries.some((e) => e.text?.includes('notification parse failed'));

  assertTruthy(hasInfo, 'notifications loaded (info) found');
  assertTruthy(hasWarn, 'stale cache (warn) found');
  assertTruthy(hasError, 'notification parse failed (error) found');

  return '3 log levels captured';
}
