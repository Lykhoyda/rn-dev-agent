import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertGreaterThan } from '../lib/assertions.js';

export async function componentTreeSuite(client: McpTestClient): Promise<string> {
  const result = await client.callTool('cdp_component_tree', {
    filter: 'home-welcome',
    depth: 3,
  });
  assertTruthy(!result.isError, 'component_tree returned error');

  const data = McpTestClient.parseResult(result) as Record<string, unknown>;
  assertTruthy(data.tree, 'tree present in response');
  assertGreaterThan(data.totalNodes as number, 0, 'totalNodes');

  const treeStr = JSON.stringify(data.tree);
  assertTruthy(treeStr.includes('home-welcome'), 'home-welcome testID found');

  const listResult = await client.callTool('cdp_component_tree', {
    filter: 'home-feature',
    depth: 2,
  });
  assertTruthy(!listResult.isError, 'feature query returned error');

  return `tree found with ${data.totalNodes} nodes`;
}
