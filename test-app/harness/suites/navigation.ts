import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertEqual } from '../lib/assertions.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function navigationSuite(client: McpTestClient): Promise<string> {
  const homeResult = await client.callTool('cdp_navigation_state');
  assertTruthy(!homeResult.isError, 'navigation_state returned error');
  const homeState = McpTestClient.parseResult(homeResult) as Record<string, unknown>;
  assertTruthy(homeState.routeName, 'routeName present');

  await client.callTool('cdp_evaluate', {
    expression: '__NAV_REF__.navigate("DeepLink", { id: "123" })',
  });
  await sleep(500);

  const deepResult = await client.callTool('cdp_navigation_state');
  assertTruthy(!deepResult.isError, 'nav state after deep link error');
  const deepState = McpTestClient.parseResult(deepResult) as Record<string, unknown>;

  const routeName = deepState.routeName as string;
  assertEqual(routeName, 'DeepLink', 'deep link route name');

  const params = deepState.params as Record<string, unknown>;
  assertEqual(params.id, '123', 'deep link id param');

  await client.callTool('cdp_evaluate', {
    expression: '__NAV_REF__.goBack()',
  });
  await sleep(300);

  return 'Home tab verified, deep link params confirmed';
}
