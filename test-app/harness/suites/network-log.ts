import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertGreaterThan } from '../lib/assertions.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function networkLogSuite(client: McpTestClient): Promise<string> {
  await client.callTool('cdp_network_log', { clear: true });

  await client.callTool('cdp_evaluate', {
    expression: '__NAV_REF__.navigate("Tabs", { screen: "HomeTab", params: { screen: "Feed" } })',
  });
  await sleep(1500);

  const result = await client.callTool('cdp_network_log', { limit: 10 });
  assertTruthy(!result.isError, 'network_log returned error');

  const data = McpTestClient.parseResult(result) as Record<string, unknown>;
  assertTruthy(data.mode, 'mode field present');

  if (data.mode === 'hook') {
    assertGreaterThan(data.count as number, 0, 'network entries captured via hook');
    const requests = data.requests as Array<Record<string, unknown>>;
    const feedReq = requests.find((r) => (r.url as string).includes('/api/feed'));
    assertTruthy(feedReq, 'feed request found in network log');
    return `${data.count} entries captured (hook mode)`;
  }

  assertTruthy(typeof data.count === 'number', 'count field is number');
  assertTruthy(Array.isArray(data.requests), 'requests is array');
  return `buffer structure valid (cdp mode, ${data.count} entries)`;
}
