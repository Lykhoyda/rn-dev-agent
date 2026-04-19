import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTabNavigateArgs, buildScreenNameAliases } from '../../dist/tools/nav-graph.js';

// B115/D640: ref.navigate() arg shape for tab vs inner-screen targets.

test('flat call when user requested the tab itself (no params)', () => {
  const args = buildTabNavigateArgs('TasksTab', 'TasksTab', 'undefined');
  assert.equal(args, '"TasksTab", undefined');
});

test('flat call when user requested the tab itself with params', () => {
  const args = buildTabNavigateArgs('TasksTab', 'TasksTab', '{"filter":"active"}');
  assert.equal(args, '"TasksTab", {"filter":"active"}');
});

test('nested call when inner screen differs from tab', () => {
  const args = buildTabNavigateArgs('TasksTab', 'TaskDetail', 'undefined');
  assert.equal(
    args,
    '"TasksTab", { screen: "TaskDetail", params: undefined }',
  );
});

test('nested call with params when inner screen differs from tab', () => {
  const args = buildTabNavigateArgs('TasksTab', 'TaskDetail', '{"id":"1"}');
  assert.equal(
    args,
    '"TasksTab", { screen: "TaskDetail", params: {"id":"1"} }',
  );
});

test('escapes quotes via JSON.stringify', () => {
  const args = buildTabNavigateArgs('Profile"Tab', 'Profile"Tab', 'undefined');
  assert.match(args, /"Profile\\"Tab"/);
});

test('output is valid JS fragment that works as ref.navigate args', () => {
  // Simulates the downstream concatenation — shouldn't throw when embedded.
  const argsFlat = buildTabNavigateArgs('TasksTab', 'TasksTab', 'undefined');
  const expr = `ref.navigate(${argsFlat});`;
  // Valid JS — parseable as a function call
  assert.match(expr, /^ref\.navigate\("TasksTab", undefined\);$/);

  const argsNested = buildTabNavigateArgs('TasksTab', 'TaskDetail', '{"id":"1"}');
  const nestedExpr = `ref.navigate(${argsNested});`;
  assert.match(nestedExpr, /^ref\.navigate\("TasksTab", \{ screen: "TaskDetail", params: \{"id":"1"\} \}\);$/);
});

// ── B126: buildScreenNameAliases (UPPER_SNAKE_CASE → PascalCase) ──────

test('buildScreenNameAliases converts standard snake_case names', () => {
  const aliases = buildScreenNameAliases([
    'PUSH_NOTIFICATION_PROMPT',
    'MAIN_TABS_HOME',
    'TASK_DETAIL',
  ]);
  assert.deepEqual(aliases, {
    PUSH_NOTIFICATION_PROMPT: 'PushNotificationPrompt',
    MAIN_TABS_HOME: 'MainTabsHome',
    TASK_DETAIL: 'TaskDetail',
  });
});

test('buildScreenNameAliases skips PascalCase names (no underscore)', () => {
  // Name already in PascalCase — no alias needed.
  const aliases = buildScreenNameAliases(['PushNotificationPrompt', 'TaskDetail']);
  assert.deepEqual(aliases, {});
});

test('buildScreenNameAliases skips single-word UPPER names (no underscore)', () => {
  // Single uppercase word like "HOME" — converting to "Home" is a guess about
  // user intent. Skip to avoid false positives.
  const aliases = buildScreenNameAliases(['HOME', 'PROFILE']);
  assert.deepEqual(aliases, {});
});

test('buildScreenNameAliases skips camelCase names', () => {
  const aliases = buildScreenNameAliases(['pushNotificationPrompt', 'taskDetail']);
  assert.deepEqual(aliases, {});
});

test('buildScreenNameAliases handles names with digits', () => {
  // Digits should pass through. PASCAL form preserves digit positions.
  const aliases = buildScreenNameAliases(['STEP_2_REVIEW', 'OAUTH_V2_FLOW']);
  assert.deepEqual(aliases, {
    STEP_2_REVIEW: 'Step2Review',
    OAUTH_V2_FLOW: 'OauthV2Flow',
  });
});

test('buildScreenNameAliases handles consecutive underscores by skipping empty parts', () => {
  // Defensive — typo in a route name shouldn't crash.
  const aliases = buildScreenNameAliases(['FOO__BAR']);
  assert.deepEqual(aliases, { FOO__BAR: 'FooBar' });
});

test('buildScreenNameAliases skips names that begin with a digit', () => {
  // Regex requires leading uppercase letter — `404_NOT_FOUND` fails the test.
  const aliases = buildScreenNameAliases(['404_NOT_FOUND', '2FA_SCREEN']);
  assert.deepEqual(aliases, {});
});

test('buildScreenNameAliases mixed input preserves only convertible names', () => {
  const aliases = buildScreenNameAliases([
    'MAIN_TABS_HOME',  // snake → convert
    'TaskDetail',       // pascal → skip
    'pushPrompt',       // camel → skip
    'PROFILE_EDIT',     // snake → convert
    'HOME',             // single → skip
  ]);
  assert.deepEqual(aliases, {
    MAIN_TABS_HOME: 'MainTabsHome',
    PROFILE_EDIT: 'ProfileEdit',
  });
});

test('buildScreenNameAliases tolerates non-string entries', () => {
  // Defense against malformed graph data.
  // @ts-expect-error: testing runtime safety
  const aliases = buildScreenNameAliases(['MAIN_TABS_HOME', null, undefined, 42]);
  assert.deepEqual(aliases, { MAIN_TABS_HOME: 'MainTabsHome' });
});

test('buildScreenNameAliases handles empty input', () => {
  assert.deepEqual(buildScreenNameAliases([]), {});
});
