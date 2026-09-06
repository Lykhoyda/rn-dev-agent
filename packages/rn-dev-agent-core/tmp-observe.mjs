import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PROJECT = '/Users/antonlykhoyda/Github/getsafe-factory/projects/react-native-app';
const SUP = '/Users/antonlykhoyda/.treehouse/rn-dev-agent-48115a/3/rn-dev-agent/packages/rn-dev-agent-core/dist/supervisor.js';
const ADOPTION_HANDLE = 'iCqyE27RXPSCiuYtrU2zgIwvzWHWv9PROHp_jkzM8UI';

const transport = new StdioClientTransport({ command: 'node', args: [SUP], cwd: PROJECT, env: { ...process.env, FORCE_COLOR: '0' } });
const client = new Client({ name: 'rn-observer-client', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
const res1 = await client.callTool({name:'rn_session', arguments:{action:'adopt_stale', confirmed:true, adoptionHandle:ADOPTION_HANDLE}});
console.log('ADOPT', JSON.stringify(res1, null, 2));
const res2 = await client.callTool({ name: 'rn_session', arguments: { action: 'status' }});
console.log('STATUS', JSON.stringify(res2, null, 2));
const res3 = await client.callTool({ name: 'observe', arguments: { action: 'start' }});
console.log('OBSERVE', JSON.stringify(res3, null, 2));
await client.close();
