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
// - favicon.svg: Starlight emits `<link rel="icon" href="/rn-dev-agent/favicon.svg">`
//   in every page head, but the site has never shipped a favicon.svg in public/.
//   A later branding task should add public/favicon.svg and drop this skip.
const KNOWN_BROKEN = new Set([`${BASE}/favicon.svg`]);

function checkInternalLinks() {
  let broken = 0;
  for (const file of htmlFiles()) {
    const html = readFileSync(file, 'utf8');
    for (const [, url] of html.matchAll(/(?:href|src)="([^"#?]+)[#?]?[^"]*"/g)) {
      if (url !== BASE && !url.startsWith(`${BASE}/`)) continue;
      if (KNOWN_BROKEN.has(url)) continue;
      const rel = url === BASE ? '' : url.slice(BASE.length + 1);
      if (/\.(css|js|png|svg|txt|xml|ico|json|webmanifest|woff2?|ttf|webp|avif|jpe?g|gif|mp4)$/.test(rel)) {
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

if (failed > 0) {
  console.error(`\nverify-site: ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nverify-site: all assertions passed');
