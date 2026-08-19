#!/usr/bin/env node
// A gh(1) test double for workflow-step simulations. It keeps release assets and
// pull requests in a JSON state file, records every invocation, and answers
// --json/--jq queries by running the REAL jq over the projected records, so a
// workflow's own filter is exercised rather than re-implemented here.
//
// Env:
//   GH_STUB_STATE            directory holding state.json, calls.jsonl, assets/
//   GH_STUB_FAIL             comma-separated "<group> <sub>" pairs to fail
//   GH_STUB_LIST_HEAD_BLIND  `gh pr list --head` answers empty (replica lag)

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

const stateDir = process.env.GH_STUB_STATE;
if (!stateDir) die('gh stub: GH_STUB_STATE is not set');
const statePath = join(stateDir, 'state.json');
const assetsDir = join(stateDir, 'assets');

const argv = process.argv.slice(2);
appendFileSync(join(stateDir, 'calls.jsonl'), JSON.stringify(argv) + '\n');

const positional = argv.filter((a) => !a.startsWith('-'));
const command = positional.slice(0, 2).join(' ');
const injected = (process.env.GH_STUB_FAIL ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (injected.includes(command)) die(`gh stub: injected failure for \`gh ${command}\``);

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readState() {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function flags(name) {
  return argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
}

function has(name) {
  return argv.includes(name);
}

// The workflow's own --jq filter is applied by real jq; the stub only decides
// what records exist, never what a filter means.
function emit(value) {
  const filter = flag('--jq') ?? flag('-q');
  const json = JSON.stringify(value);
  if (!filter) {
    process.stdout.write(json + '\n');
    return;
  }
  const jq = spawnSync('jq', ['-r', filter], { input: json, encoding: 'utf8' });
  if (jq.error) die(`gh stub: jq is required to answer --jq queries (${jq.error.message})`);
  if (jq.status !== 0) die(`gh stub: jq failed: ${jq.stderr}`);
  process.stdout.write(jq.stdout);
}

function project(records, fieldSpec) {
  const fields = (fieldSpec ?? '').split(',').filter(Boolean);
  return records.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])));
}

function assetPath(tag, name) {
  return join(assetsDir, tag.replace(/[^\w.-]/g, '_'), name);
}

const state = readState();
const [group, sub] = argv;

if (group === 'release' && sub === 'view') {
  const tag = positional[2];
  const release = state.releases[tag];
  if (!release) die(`release not found: ${tag}`);
  if (has('--json')) emit({ assets: Object.keys(release.assets).map((name) => ({ name })) });
  else process.stdout.write(`${tag}\n`);
} else if (group === 'release' && sub === 'create') {
  const tag = positional[2];
  if (state.releases[tag]) die(`a release with tag ${tag} already exists`);
  state.releases[tag] = { assets: {} };
  writeState(state);
  process.stdout.write(
    `https://github.com/${process.env.GH_REPO ?? 'owner/repo'}/releases/${tag}\n`,
  );
} else if (group === 'release' && sub === 'download') {
  const tag = positional[2];
  const release = state.releases[tag];
  if (!release) die(`release not found: ${tag}`);
  const patterns = flags('--pattern');
  const wanted = patterns.filter((p) => release.assets[p]);
  if (wanted.length === 0) die(`no assets match the given patterns: ${patterns.join(', ')}`);
  const out = flag('--output');
  if (out && wanted.length > 1) die('--output can only be used with a single asset');
  for (const name of wanted) {
    const target = out ?? name;
    if (existsSync(target) && !has('--clobber') && !out) die(`${target} already exists`);
    copyFileSync(assetPath(tag, name), target);
  }
} else if (group === 'release' && sub === 'upload') {
  const tag = positional[2];
  const release = state.releases[tag];
  if (!release) die(`release not found: ${tag}`);
  const files = positional.slice(3);
  for (const file of files) {
    const name = basename(file);
    if (release.assets[name] && !has('--clobber')) {
      die(`an asset called ${name} already exists — pass --clobber to replace it`);
    }
    const target = assetPath(tag, name);
    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(file, target);
    release.assets[name] = { uploads: (release.assets[name]?.uploads ?? 0) + 1 };
  }
  writeState(state);
} else if (group === 'api') {
  const endpoint = (positional[1] ?? '').replace(
    '{owner}/{repo}',
    process.env.GH_REPO ?? 'owner/repo',
  );
  const [path, query] = endpoint.split('?');
  if (/^repos\/[^/]+\/[^/]+\/pulls$/.test(path)) {
    // Paged the way the REST API pages: without --paginate a caller sees at
    // most one page.
    const params = new URLSearchParams(query ?? '');
    const wantState = (params.get('state') ?? 'open').toUpperCase();
    const perPage = Number(params.get('per_page') ?? 30);
    const matching = state.prs.filter((pr) => wantState === 'ALL' || pr.state === wantState);
    const pages = has('--paginate') ? [matching] : [matching.slice(0, perPage)];
    for (const page of pages) {
      emit(page.map((pr) => ({ number: pr.number, head: { ref: pr.headRefName } })));
    }
  } else if (/^repos\/[^/]+\/[^/]+\/compare\/.+\.\.\..+$/.test(path)) {
    // Answered from the fixture's real repository, so ahead_by/behind_by/files
    // carry the same merge-base semantics the compare endpoint does.
    const gitDir = process.env.GH_STUB_GIT_DIR;
    if (!gitDir) die('gh stub: GH_STUB_GIT_DIR is required to answer a compare');
    const [base, head] = path.slice(path.indexOf('/compare/') + '/compare/'.length).split('...');
    const git = (...args) => {
      const result = spawnSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8' });
      if (result.status !== 0) die(`gh stub: git ${args.join(' ')} failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    const mergeBase = git('merge-base', base, head);
    emit({
      merge_base_commit: { sha: mergeBase },
      ahead_by: Number(git('rev-list', '--count', `${mergeBase}..${head}`)),
      behind_by: Number(git('rev-list', '--count', `${head}..${base}`)),
      files: git('diff', '--name-only', mergeBase, head)
        .split('\n')
        .filter(Boolean)
        .map((filename) => ({ filename })),
    });
  } else {
    die(`gh stub: unsupported api endpoint: ${endpoint}`);
  }
} else if (group === 'pr' && sub === 'list') {
  const head = flag('--head');
  const base = flag('--base');
  const wantState = (flag('--state') ?? 'open').toUpperCase();
  const blind = head && process.env.GH_STUB_LIST_HEAD_BLIND === '1';
  const matches = blind
    ? []
    : state.prs.filter(
        (pr) =>
          (!head || pr.headRefName === head) &&
          (!base || pr.baseRefName === base) &&
          (wantState === 'ALL' || pr.state === wantState),
      );
  emit(project(matches.slice(0, Number(flag('--limit') ?? 30)), flag('--json')));
} else if (group === 'pr' && sub === 'create') {
  const head = flag('--head');
  const existing = state.prs.find((pr) => pr.headRefName === head && pr.state === 'OPEN');
  if (existing) die(`a pull request for branch "${head}" already exists: #${existing.number}`);
  const number = state.nextPr++;
  state.prs.push({
    number,
    headRefName: head,
    baseRefName: flag('--base'),
    title: flag('--title'),
    body: flag('--body'),
    state: 'OPEN',
    autoMerge: null,
    closeComment: null,
  });
  writeState(state);
  process.stdout.write(
    `https://github.com/${process.env.GH_REPO ?? 'owner/repo'}/pull/${number}\n`,
  );
} else if (group === 'pr' && sub === 'close') {
  const number = Number(positional[2]);
  const pr = state.prs.find((p) => p.number === number);
  if (!pr || pr.state !== 'OPEN') die(`no open pull request found for "${positional[2]}"`);
  pr.state = 'CLOSED';
  pr.closeComment = flag('--comment') ?? null;
  writeState(state);
} else if (group === 'pr' && sub === 'merge') {
  const number = Number(positional[2]);
  const pr = state.prs.find((p) => p.number === number);
  if (!pr || pr.state !== 'OPEN') die(`no open pull request found for "${positional[2] ?? ''}"`);
  if (has('--admin')) die('gh stub: --admin is not available to this token');
  pr.autoMerge = has('--auto') ? (has('--squash') ? 'squash' : 'merge') : null;
  writeState(state);
  if (!has('--auto')) die('gh stub: the base branch requires all checks to pass');
  process.stdout.write(
    `✓ Pull request #${number} will be automatically merged when all requirements are met\n`,
  );
} else {
  die(`gh stub: unsupported invocation: gh ${argv.join(' ')}`);
}
