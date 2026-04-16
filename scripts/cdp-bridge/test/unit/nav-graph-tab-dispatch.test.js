import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTabNavigateArgs } from '../../dist/tools/nav-graph.js';

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
