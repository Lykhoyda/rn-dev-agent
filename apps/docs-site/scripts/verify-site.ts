import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const BASE = '/rn-dev-agent';
let failed = 0;

function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}`);
  }
}

function exists(relPath) {
  return existsSync(join(DIST, relPath));
}

function page(relPath) {
  return readFileSync(join(DIST, relPath), 'utf8');
}

function htmlFiles(dir = DIST) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith('.html') ? [path] : [];
  });
}

// KNOWN pre-existing broken references, skipped by the link check with a reason.
// Not introduced by this plan; remove an entry once the underlying asset ships.
const KNOWN_BROKEN = new Set();

function checkInternalLinks() {
  let broken = 0;
  for (const file of htmlFiles()) {
    const html = readFileSync(file, 'utf8');
    for (const [, url] of html.matchAll(/(?:href|src)="([^"#?]+)[#?]?[^"]*"/g)) {
      if (url !== BASE && !url.startsWith(`${BASE}/`)) continue;
      if (KNOWN_BROKEN.has(url)) continue;
      const rel = url === BASE ? '' : url.slice(BASE.length + 1);
      if (
        /\.(css|js|png|svg|txt|xml|ico|json|webmanifest|woff2?|ttf|webp|avif|jpe?g|gif|mp4)$/.test(
          rel,
        )
      ) {
        if (!exists(rel)) {
          broken += 1;
          console.error(`  broken asset ${url} in ${file.slice(DIST.length)}`);
        }
        continue;
      }
      const target = rel === '' ? 'index.html' : join(rel, 'index.html');
      if (!exists(target) && !exists(rel)) {
        broken += 1;
        console.error(`  broken link ${url} in ${file.slice(DIST.length)}`);
      }
    }
  }
  check('no broken internal links or assets', broken === 0);
}

console.log('verify-site: baseline');
check('dist exists (run `yarn build` first)', existsSync(DIST));
check('landing page built', exists('index.html'));
check('getting-started built', exists('getting-started/index.html'));
check('tools overview built', exists('tools/index.html'));
check('a generated CDP tool page built', exists('tools/cdp/cdp_status/index.html'));
checkInternalLinks();

// ── TASK ASSERTIONS (appended by later tasks) ──

console.log('\nverify-site: IA restructure');
const gs = page('getting-started/index.html');
for (const group of ['Start Here', 'Core Concepts', 'Guides', 'Reference', 'Project']) {
  check(`sidebar group "${group}"`, gs.includes(group));
}
check('orphan dev-client-coverage page is in sidebar', gs.includes('dev-client-coverage'));

console.log('\nverify-site: best-practices consolidation');
check('rule pages removed', !exists('best-practices/rules'));
const bp = page('best-practices/index.html');
check('overview links to Vercel agent-skills', bp.includes('github.com/vercel-labs/agent-skills'));
check('overview names a custom rule', bp.includes('reanimated-in-lists'));

console.log('\nverify-site: landing foundation');
const landing = page('index.html');
check('headline present', landing.includes('This proves it runs.'));
check('install command present', landing.includes('/plugin marketplace add Lykhoyda/rn-dev-agent'));
check(
  'eyebrow version comes from plugin.json',
  landing.includes(
    `v${JSON.parse(readFileSync(join(DIST, '../../../packages/claude-plugin/.claude-plugin/plugin.json'), 'utf8')).version}`,
  ),
);
check('full transcript is static text', landing.includes('Verified on iPhone 16 Pro'));
check('links use base path', landing.includes('href="/rn-dev-agent/getting-started/"'));
check('no Starlight splash remnants', !landing.includes('class="hero"'));

console.log('\nverify-site: landing sections');
const landing2 = page('index.html');
check('stat strip present', landing2.includes('210×') && landing2.includes('79'));
check('problem section present', landing2.includes('Coding agents ship blind'));
check(
  'three-layer grid present',
  ['Introspect', 'Interact', 'Replay'].every((w) => landing2.includes(w)),
);
check(
  'tabbed showcase present',
  landing2.includes('cdp_component_tree') && landing2.includes('cdp_run_action'),
);
check('pipeline strip present', landing2.includes('Verify live'));

console.log('\nverify-site: terminal animation');
// Astro 6 inlines small processed <script>s into index.html rather than always
// externalizing to _astro/*.js, so scan both the built bundles AND the landing HTML.
const bundle =
  readdirSync(join(DIST, '_astro'))
    .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
    .map((f) => readFileSync(join(DIST, '_astro', f), 'utf8'))
    .join('') + page('index.html');
check('driver respects reduced motion', bundle.includes('prefers-reduced-motion'));
check('driver uses IntersectionObserver', bundle.includes('IntersectionObserver'));
check('caret is aria-hidden', bundle.includes('t-caret') && bundle.includes('aria-hidden'));

console.log('\nverify-site: docs theme');
const docsCss = readdirSync(join(DIST, '_astro'))
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(DIST, '_astro', f), 'utf8'))
  .join('');
check('docs css bundle contains rda theme tokens', docsCss.includes('rda-docs-theme'));

console.log('\nverify-site: llms.txt');
check('llms.txt generated', exists('llms.txt'));
check(
  'llms.txt mentions the project',
  exists('llms.txt') && page('llms.txt').includes('rn-dev-agent'),
);

console.log('\nverify-site: og image');
check('og-image.png shipped', exists('og-image.png'));
check('favicon shipped', exists('favicon.svg'));

console.log('\nverify-site: gfm tables (B166)');
const archHtml = page('architecture/index.html');
check('architecture tables render', (archHtml.match(/<table/g) ?? []).length >= 5);
check('tools overview table renders', page('tools/index.html').includes('<table'));
check(
  'md pages unaffected',
  (page('dev-client-coverage/index.html').match(/<table/g) ?? []).length === 1,
);

console.log('\nverify-site: concept scenes — engine + verify loop');
const gsHtml = page('getting-started/index.html');
check('verify-loop scene mounted', gsHtml.includes('data-scene-id="verify-loop"'));
check('scene static-complete', gsHtml.includes('report with evidence'));
const sceneBundle =
  readdirSync(join(DIST, '_astro'))
    .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
    .map((f) => readFileSync(join(DIST, '_astro', f), 'utf8'))
    .join('') + gsHtml;
check(
  'scene driver present',
  sceneBundle.includes('data-scene-id') && sceneBundle.includes('is-animated'),
);
check('scene reduced-motion override inlined', gsHtml.includes('prefers-reduced-motion'));

console.log('\nverify-site: three-layer scene');
const archHtml2 = page('architecture/index.html');
check('three-layer scene mounted', archHtml2.includes('data-scene-id="three-layers"'));
check('busy chip present statically', archHtml2.includes('BUSY_FLOW_ACTIVE'));

console.log('\nverify-site: actions lifecycle scene');
const actionsHtml = page('actions/index.html');
check('actions scene mounted', actionsHtml.includes('data-scene-id="actions-lifecycle"'));
check(
  'payoff numerals present statically',
  actionsHtml.includes('al-payoff') && actionsHtml.includes('14 min'),
);

console.log('\nverify-site: page-title kicker');
check('kicker on architecture', page('architecture/index.html').includes('page-kicker'));
check('kicker shows sidebar group', page('architecture/index.html').includes('Core Concepts'));
check('kicker on reference page', page('tools/index.html').includes('page-kicker'));

console.log('\nverify-site: rhythm + steps');
check('getting-started uses Steps', page('getting-started/index.html').includes('sl-steps'));
const rhythmCss = readdirSync(join(DIST, '_astro'))
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(DIST, '_astro', f), 'utf8'))
  .join('');
check('rhythm rules shipped', rhythmCss.includes('rda-lead'));

console.log('\nverify-site: benchmarks redesign + stat swap');
const benchHtml = page('benchmarks/index.html');
check(
  'benchmarks jargon removed',
  !benchHtml.includes('Ralph Loop') && !benchHtml.includes('Polar Star'),
);
check('stale dispatch tiers removed', !benchHtml.includes('agent-device daemon'));
check(
  'benchmarks leads with verified-feature timing',
  benchHtml.includes('Description → verified feature'),
);
const landingStat = page('index.html');
check('stories stat replaced', !landingStat.includes('stories built / crashes'));
check('time-to-verified stat present', landingStat.includes('3–25 min'));

console.log('\nverify-site: troubleshooting catalog');
const tsHtml = page('troubleshooting/index.html');
check(
  'quick-reference table present',
  tsHtml.includes('Quick reference') && tsHtml.includes('<table'),
);
check(
  'error codes documented',
  ['RN_FAST_RUNNER_DOWN', 'BUSY_FOREIGN_FLOW', 'RUNNER_PROTOCOL_MISMATCH'].every((c) =>
    tsHtml.includes(c),
  ),
);
check('aside wall replaced', (tsHtml.match(/starlight-aside/g) ?? []).length <= 2);

if (failed > 0) {
  console.error(`\nverify-site: ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nverify-site: all assertions passed');
