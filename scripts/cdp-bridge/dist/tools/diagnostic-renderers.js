// Issue #126 follow-up — diagnostic helper for "fiber root invisibility"
// bug reports. Returns a complete enumeration of registered React renderers
// + their root counts so users can self-serve diagnose Gap-B-style failures
// (modal/portal mounted but cdp_component_tree returns empty).
//
// Read-only: makes no mutations. Surfaces the raw shape of
// __REACT_DEVTOOLS_GLOBAL_HOOK__ in a single round-trip.
import { okResult, failResult, withConnection } from '../utils.js';
const DIAGNOSTIC_RENDERERS_JS = `(function(opts) {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) {
    return JSON.stringify({
      hookPresent: false,
      hookKeys: [],
      rendererCount: 0,
      rendererKeys: [],
      rows: [],
      scannedRange: { from: 0, to: 0 },
      earlyExited: false,
      notes: ['__REACT_DEVTOOLS_GLOBAL_HOOK__ is not defined — DevTools backend has not loaded. Verify you are on a Dev Client / dev-mode bundle.']
    });
  }

  var max = (opts && opts.maxRendererId) ? opts.maxRendererId : 20;
  var notes = [];
  var hookKeys = [];
  for (var k in hook) {
    if (Object.prototype.hasOwnProperty.call(hook, k)) hookKeys.push(k);
  }

  var rendererKeys = [];
  if (hook.renderers && typeof hook.renderers.forEach === 'function') {
    hook.renderers.forEach(function(_v, key) {
      if (typeof key === 'number') rendererKeys.push(key);
    });
    rendererKeys.sort(function(a, b) { return a - b; });
  } else {
    notes.push('hook.renderers is not a Map — falling back to iteration only.');
  }

  if (typeof hook.getFiberRoots !== 'function') {
    return JSON.stringify({
      hookPresent: true,
      hookKeys: hookKeys,
      rendererCount: rendererKeys.length,
      rendererKeys: rendererKeys,
      rows: [],
      scannedRange: { from: 0, to: 0 },
      earlyExited: false,
      notes: notes.concat(['hook.getFiberRoots is missing. Cannot enumerate fiber roots — DevTools backend may be a stub.'])
    });
  }

  function summarize(rootCurrent) {
    if (!rootCurrent || typeof rootCurrent !== 'object') return null;
    var typeName = (rootCurrent.type && (rootCurrent.type.displayName || rootCurrent.type.name)) || null;
    var childTypeName = null;
    var testID = null;
    if (rootCurrent.child) {
      var c = rootCurrent.child;
      childTypeName = (c.type && (c.type.displayName || c.type.name)) || null;
      var props = c.memoizedProps;
      if (props && typeof props === 'object' && props.testID) testID = String(props.testID);
    }
    return { typeName: typeName, childTypeName: childTypeName, testID: testID };
  }

  var rows = [];
  var emptyStreak = 0;
  var earlyExited = false;
  for (var ri = 1; ri <= max; ri++) {
    try {
      var roots = hook.getFiberRoots(ri);
      if (roots && roots.size) {
        emptyStreak = 0;
        var rootInfo = [];
        var it = roots.values();
        var step = it.next();
        while (!step.done) {
          if (step.value && step.value.current) {
            var s = summarize(step.value.current);
            if (s) rootInfo.push(s);
          }
          step = it.next();
        }
        rows.push({ rendererId: ri, rootCount: roots.size, roots: rootInfo });
      } else {
        rows.push({ rendererId: ri, rootCount: 0 });
        emptyStreak++;
        if (emptyStreak >= 3 && ri >= 5) { earlyExited = true; break; }
      }
    } catch (err) {
      rows.push({ rendererId: ri, rootCount: null, error: String(err && err.message || err) });
      emptyStreak++;
    }
  }

  if (earlyExited) {
    for (var rk = 0; rk < rendererKeys.length; rk++) {
      var matched = false;
      for (var rr = 0; rr < rows.length; rr++) {
        if (rows[rr].rendererId === rendererKeys[rk]) { matched = true; break; }
      }
      if (!matched) {
        notes.push('Renderer ID ' + rendererKeys[rk] + ' was registered but not scanned (early-exit). Pass maxRendererId=' + (rendererKeys[rk] + 5) + ' to include it.');
      }
    }
  }

  return JSON.stringify({
    hookPresent: true,
    hookKeys: hookKeys,
    rendererCount: rendererKeys.length || rows.filter(function(r) { return r.rootCount && r.rootCount > 0; }).length,
    rendererKeys: rendererKeys,
    rows: rows,
    scannedRange: { from: 1, to: rows.length ? rows[rows.length - 1].rendererId : 0 },
    earlyExited: earlyExited,
    notes: notes
  });
})`;
export function createDiagnosticRenderersHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        const max = args.maxRendererId ?? 20;
        if (max < 1 || max > 100) {
            return failResult(`cdp_diagnostic_renderers: maxRendererId must be 1..100 (got ${max})`);
        }
        const expression = `${DIAGNOSTIC_RENDERERS_JS}({maxRendererId: ${JSON.stringify(max)}})`;
        const result = await client.evaluate(expression);
        if (result.error) {
            return failResult(`cdp_diagnostic_renderers: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return failResult('cdp_diagnostic_renderers: hook probe returned non-string');
        }
        try {
            const parsed = JSON.parse(result.value);
            return okResult(parsed);
        }
        catch (err) {
            return failResult(`cdp_diagnostic_renderers: failed to parse hook probe response: ${String(err)}`);
        }
    });
}
