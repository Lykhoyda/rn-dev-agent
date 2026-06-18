// GH #136: cdp_status must probe the dev-client picker BEFORE attempting
// autoConnect. The previous flow ran the picker check only inside the catch
// block of autoConnect's failure path, eating the full 60s discovery timeout
// on every cdp_status call when the picker was up.
//
// The tests below track call order in a shared `events` array so we can
// assert the sequence directly — `pickerProbe` must precede `autoConnect`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockClient } from "../helpers/mock-cdp-client.js";
import { expectOk } from "../helpers/result-helpers.js";
import { createStatusHandler } from "../../dist/tools/status.js";
import {
  _setRunAgentDeviceForTest,
  _resetRunAgentDeviceForTest,
  _setHasSessionForTest,
  _resetHasSessionForTest,
  _setFetchCandidatesForTest,
  _resetFetchCandidatesForTest,
} from "../../dist/tools/dev-client-picker.js";

function makeStatusProbe(extraAppInfo = {}) {
  return JSON.stringify({
    appInfo: { __DEV__: true, ...extraAppInfo },
    errorCount: 0,
    fiberTree: true,
    hasRedBox: false,
    helpersLoaded: true,
  });
}

test("cdp_status: picker probe runs BEFORE autoConnect when not connected", async () => {
  const events = [];
  _setHasSessionForTest(true);
  let probeCount = 0;
  _setFetchCandidatesForTest(async (_text) => {
    // Only record the first probe call; subsequent PICKER_INDICATORS loop
    // calls are part of the same probe sweep and must not double-push the event.
    if (probeCount === 0) events.push("pickerProbe");
    probeCount++;
    // Picker is gone — no candidates. precheck dismisses without any further work.
    return { ok: true, candidates: [] };
  });
  const client = createMockClient({
    _isConnected: false,
    _helpersInjected: true,
    autoConnect: async () => {
      events.push("autoConnect");
      client._isConnected = true;
      client._helpersInjected = true;
      return "connected";
    },
    evaluate: async () => ({ value: makeStatusProbe() }),
  });
  try {
    const handler = createStatusHandler(
      () => client,
      () => {},
      () => client,
    );
    expectOk(await handler({}));
    assert.deepEqual(
      events,
      ["pickerProbe", "autoConnect"],
      `events out of order: ${JSON.stringify(events)}`,
    );
  } finally {
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});

test("cdp_status: picker probe is skipped when already connected", async () => {
  let pickerProbed = false;
  _setHasSessionForTest(true);
  _setFetchCandidatesForTest(async (text) => {
    if (text === "Development servers" || text === "DEVELOPMENT SERVERS") {
      pickerProbed = true;
      return { ok: true, candidates: [] };
    }
    return { ok: true, candidates: [] };
  });
  const client = createMockClient({
    _isConnected: true,
    _helpersInjected: true,
    evaluate: async () => ({ value: makeStatusProbe() }),
  });
  try {
    const handler = createStatusHandler(
      () => client,
      () => {},
      () => client,
    );
    expectOk(await handler({}));
    assert.equal(pickerProbed, false, "connected client should NOT trigger picker probe");
  } finally {
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});
