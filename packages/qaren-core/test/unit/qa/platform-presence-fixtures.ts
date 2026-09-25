export function nativeCapture() {
  const presenceCapture = {
    version: 1,
    source: 'xcui-live',
    captureId: 'capture-7',
    appId: 'com.test',
    generation: 7,
    startedUptimeMs: 100,
    endedUptimeMs: 200,
    enumeration: 'raw-unfiltered',
    complete: true,
  };
  const nodes = [
    {
      ref: '@e0',
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Test app',
      enabled: true,
      hittable: true,
      rect: { x: 0, y: 0, width: 400, height: 800 },
      presence: {
        captureId: 'capture-7',
        generation: 7,
        nodeIndex: 0,
        status: 'unknown',
        labelSource: 'direct',
      },
    },
    {
      ref: '@e1',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'save',
      label: 'Save',
      enabled: true,
      hittable: true,
      rect: { x: 10, y: 20, width: 100, height: 40 },
      presence: {
        captureId: 'capture-7',
        generation: 7,
        nodeIndex: 1,
        status: 'observed',
        labelSource: 'direct',
        observedUptimeMs: 150,
      },
    },
  ];
  return {
    keyboardVisible: false,
    presenceCapture,
    nodes,
    snapshotGeneration: 7,
    truncated: false,
    normalizationDroppedNodes: 0,
    snapshotVerdict: { state: 'ok', nodeCount: 2, refMapUpdated: true, reasons: [] },
  };
}
