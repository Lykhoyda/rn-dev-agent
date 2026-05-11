// Verify PR-B picker logic against representative real-world snapshots.
// Imports the freshly-compiled NEW dist (not the OLD one running in MCP).
import {
  parsePortPatternEntry,
  parseFirstServerEntry,
} from '/Users/anton_personal/GitHub/claude-react-native-dev-plugin/scripts/cdp-bridge/dist/tools/dev-client-picker.js';

const cases = [
  {
    name: 'Real LAN-IP picker from #136 reproducer',
    snapshot: 'Development servers\nrn-dev-agent-test-app\n192.168.1.5:8081\nEnter URL manually\nFetch development servers',
    expected: '192.168.1.5:8081',
  },
  {
    name: 'Android emulator alias picker',
    snapshot: 'DEVELOPMENT SERVERS\nrn-dev-agent-test-app\n10.0.2.2:8081\nEnter URL manually',
    expected: '10.0.2.2:8081',
  },
  {
    name: 'Localhost-only picker (the original "happy path")',
    snapshot: 'Development servers\nlocalhost:8081\nEnter URL manually',
    expected: 'localhost:8081',
  },
  {
    name: 'Real-world: picker with manifest name only (URL hidden)',
    snapshot: 'Development servers\nrn-dev-agent-test-app\nEnter URL manually\nFetch development servers',
    expected: 'rn-dev-agent-test-app',
  },
  {
    name: 'Decorative substring trap (Codex/Gemini caught this)',
    snapshot: 'Development servers\nOpen localhost in browser\n192.168.1.5:8081',
    expected: '192.168.1.5:8081', // Must NOT short-circuit to "localhost"
  },
  {
    name: 'Localized footer (Codex caught this)',
    snapshot: 'Development servers\nrn-dev-agent-test-app\nENTER URL MANUALLY',
    expected: 'rn-dev-agent-test-app', // Must skip the uppercase footer
  },
  {
    name: 'Version-banner trap (Gemini caught this)',
    snapshot: 'Development servers\nbuild v1.2.3:1234\nrn-dev-agent-test-app\n192.168.1.5:8081',
    expected: '192.168.1.5:8081', // Must reject v1.2.3:1234 as host
  },
  {
    name: 'No picker — should return null',
    snapshot: 'Welcome\nGet started\nLog in',
    expected: null,
  },
  {
    name: 'host.local hostname with port',
    snapshot: 'Development servers\nantons-macbook.local:8081\nEnter URL manually',
    expected: 'antons-macbook.local:8081',
  },
];

let pass = 0, fail = 0;
console.log('PR-B picker logic verification — new dist\n');
for (const c of cases) {
  const got = parseFirstServerEntry(c.snapshot);
  const ok = got === c.expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✓' : '✗'} ${c.name}`);
  console.log(`    expected: ${JSON.stringify(c.expected)}`);
  console.log(`    got:      ${JSON.stringify(got)}`);
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
