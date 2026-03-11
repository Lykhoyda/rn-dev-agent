import { McpTestClient } from './lib/mcp-client.js';

export interface SuiteResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  message: string;
  durationMs: number;
}

export type Suite = (client: McpTestClient) => Promise<string>;

const SUITE_TIMEOUT_MS = 15_000;

async function runSuite(client: McpTestClient, name: string, suite: Suite): Promise<SuiteResult> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      suite(client),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${SUITE_TIMEOUT_MS}ms`)), SUITE_TIMEOUT_MS),
      ),
    ]);
    return { name, status: 'pass', message: result, durationMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', message, durationMs: Date.now() - start };
  }
}

async function main(): Promise<void> {
  const { statusSuite } = await import('./suites/status.js');
  const { evaluateSuite } = await import('./suites/evaluate.js');
  const { componentTreeSuite } = await import('./suites/component-tree.js');
  const { navigationSuite } = await import('./suites/navigation.js');
  const { storeStateSuite } = await import('./suites/store-state.js');
  const { networkLogSuite } = await import('./suites/network-log.js');
  const { consoleLogSuite } = await import('./suites/console-log.js');
  const { errorLogSuite } = await import('./suites/error-log.js');
  const { devSettingsSuite } = await import('./suites/dev-settings.js');
  const { reloadSuite } = await import('./suites/reload.js');

  const suites: Array<[string, Suite]> = [
    ['cdp_status', statusSuite],
    ['cdp_evaluate', evaluateSuite],
    ['cdp_component_tree', componentTreeSuite],
    ['cdp_navigation_state', navigationSuite],
    ['cdp_store_state', storeStateSuite],
    ['cdp_network_log', networkLogSuite],
    ['cdp_console_log', consoleLogSuite],
    ['cdp_error_log', errorLogSuite],
    ['cdp_dev_settings', devSettingsSuite],
    ['cdp_reload', reloadSuite],
  ];

  console.log('Connecting to cdp-bridge MCP server...');
  const client = new McpTestClient();
  await client.connect();
  console.log('Connected. Running suites...\n');

  const results: SuiteResult[] = [];
  for (const [name, suite] of suites) {
    const result = await runSuite(client, name, suite);
    const tag = result.status === 'pass' ? '\x1b[32m[PASS]\x1b[0m'
      : result.status === 'fail' ? '\x1b[31m[FAIL]\x1b[0m'
      : '\x1b[33m[SKIP]\x1b[0m';
    console.log(`${tag} ${result.name} — ${result.message} (${result.durationMs}ms)`);
    results.push(result);
  }

  await client.close();

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(`\n${results.length} suites: ${passed} passed, ${failed} failed`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Harness fatal error:', err);
  process.exit(1);
});
