import { McpTestClient } from '../lib/mcp-client.js';
import { assertTruthy, assertShape, assertEqual } from '../lib/assertions.js';

export async function statusSuite(client: McpTestClient): Promise<string> {
  const result = await client.callTool('cdp_status');
  assertTruthy(!result.isError, 'cdp_status returned error');

  const data = McpTestClient.parseResult(result) as Record<string, unknown>;
  assertShape(data, ['metro', 'cdp', 'app', 'capabilities'], 'status response shape');

  const metro = data.metro as Record<string, unknown>;
  assertEqual(metro.running, true, 'metro.running');

  const cdp = data.cdp as Record<string, unknown>;
  assertEqual(cdp.connected, true, 'cdp.connected');

  const app = data.app as Record<string, unknown>;
  assertEqual(app.hermes, true, 'app.hermes');
  assertEqual(app.dev, true, 'app.dev');
  assertEqual(app.hasRedBox, false, 'app.hasRedBox');

  return 'connected, app info valid';
}
