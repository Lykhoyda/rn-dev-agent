import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertEqual } from '../lib/assertions.js';

export async function storeStateSuite(client: McpTestClient): Promise<string> {
  const nameResult = await client.callTool('cdp_store_state', { path: 'user.name' });
  assertTruthy(!nameResult.isError, 'store_state user.name error');
  const nameData = McpTestClient.parseResult(nameResult) as Record<string, unknown>;
  assertEqual(nameData.type, 'redux', 'store type is redux');
  assertEqual(nameData.state, 'Test User', 'user.name value');

  const feedResult = await client.callTool('cdp_store_state', { path: 'feed.items' });
  assertTruthy(!feedResult.isError, 'store_state feed.items error');
  const feedData = McpTestClient.parseResult(feedResult) as Record<string, unknown>;
  assertTruthy(Array.isArray(feedData.state), 'feed.items is array');

  const themeResult = await client.callTool('cdp_store_state', { path: 'settings.theme' });
  assertTruthy(!themeResult.isError, 'store_state settings.theme error');
  const themeData = McpTestClient.parseResult(themeResult) as Record<string, unknown>;
  assertEqual(themeData.state, 'light', 'settings.theme value');

  return 'user.name and feed.items match';
}
