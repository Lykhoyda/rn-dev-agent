import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstWorkspaceFolder,
  isCursorHost,
  isHomeProjectRoot,
  seedHostProjectRoot,
  shouldAcquireProcessLock,
} from '../../dist/lifecycle/host-process-lock.js';

test('firstWorkspaceFolder: JSON array, unix paths, windows paths', () => {
  assert.equal(firstWorkspaceFolder('["/Users/a/app","/other"]'), '/Users/a/app');
  assert.equal(firstWorkspaceFolder('/Users/a/app:/other'), '/Users/a/app');
  assert.equal(firstWorkspaceFolder('C:\\Users\\a\\app;D:\\b', 'win32'), 'C:\\Users\\a\\app');
  assert.equal(firstWorkspaceFolder('C:\\Users\\a\\app', 'win32'), 'C:\\Users\\a\\app');
  assert.equal(firstWorkspaceFolder('   '), undefined);
  assert.equal(firstWorkspaceFolder('[not-json'), undefined);
});

test('isCursorHost: CURSOR_PLUGIN_ROOT or WORKSPACE_FOLDER_PATHS', () => {
  assert.equal(isCursorHost({}), false);
  assert.equal(isCursorHost({ CURSOR_PLUGIN_ROOT: '/plugins/rn-dev-agent' }), true);
  assert.equal(isCursorHost({ WORKSPACE_FOLDER_PATHS: '/Users/a/app' }), true);
  assert.equal(isCursorHost({ WORKSPACE_FOLDER_PATHS: '  ' }), false);
});

test('seedHostProjectRoot: fills CLAUDE_USER_CWD once from workspace folders', () => {
  const env: NodeJS.ProcessEnv = { WORKSPACE_FOLDER_PATHS: '["/Users/a/app"]' };
  assert.equal(seedHostProjectRoot(env), '/Users/a/app');
  assert.equal(env.CLAUDE_USER_CWD, '/Users/a/app');
  env.WORKSPACE_FOLDER_PATHS = '["/other"]';
  assert.equal(seedHostProjectRoot(env), '/Users/a/app');
});

test('shouldAcquireProcessLock: Claude project acquires; Cursor and home skip', () => {
  assert.equal(
    shouldAcquireProcessLock(
      ['node', 'supervisor.js'],
      { CLAUDE_USER_CWD: '/Users/a/app' },
      '/Users/a/app',
      '/Users/a',
    ),
    true,
  );
  assert.equal(
    shouldAcquireProcessLock(
      ['node', 'supervisor.js'],
      { CURSOR_PLUGIN_ROOT: '/plugins/rn-dev-agent', CLAUDE_USER_CWD: '/Users/a/app' },
      '/Users/a/app',
      '/Users/a',
    ),
    false,
  );
  assert.equal(
    shouldAcquireProcessLock(
      ['node', 'supervisor.js'],
      { WORKSPACE_FOLDER_PATHS: '["/Users/a/app"]', CLAUDE_USER_CWD: '/Users/a/app' },
      '/Users/a/app',
      '/Users/a',
    ),
    false,
  );
  assert.equal(
    shouldAcquireProcessLock(
      ['node', 'supervisor.js', '--no-lock'],
      {},
      '/Users/a/app',
      '/Users/a',
    ),
    false,
  );
  assert.equal(
    shouldAcquireProcessLock(['node', 'supervisor.js'], {}, '/Users/a', '/Users/a'),
    false,
  );
  assert.equal(isHomeProjectRoot('/Users/a', '/Users/a'), true);
  assert.equal(isHomeProjectRoot('/Users/a/app', '/Users/a'), false);
});
