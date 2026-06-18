import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

type Family = 'interaction' | 'introspection' | 'navigation' | 'lifecycle' | 'testing' | 'other';

interface AgentEvent {
  seq: number;
  ts: number;
  tool: string;
  family: Family;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs?: number;
  error?: { message: string; code?: string };
  ghost?: { attempted: boolean; outcome: string };
  summary: string;
  payload?: unknown;
  truncated?: boolean;
}

const MAX_EVENTS = 500;
const RENDER_ROWS = 250;

const FAMILY_COLOR: Record<Family, string> = {
  interaction: '#7aa2f7',
  introspection: '#9ece6a',
  navigation: '#e0af68',
  lifecycle: '#bb9af7',
  testing: '#f7768e',
  other: '#787c99',
};

function latestByTool(events: AgentEvent[], tools: string[]): AgentEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (tools.includes(events[i].tool)) return events[i];
  }
  return undefined;
}

function latestByFamily(events: AgentEvent[], family: Family): AgentEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].family === family) return events[i];
  }
  return undefined;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function routeOf(ev: AgentEvent | undefined): string | undefined {
  if (!ev) return undefined;
  const p = ev.payload as
    | { routeName?: string; nested?: { routeName?: string; nested?: { routeName?: string } } }
    | undefined;
  const cand = p?.nested?.nested?.routeName ?? p?.nested?.routeName ?? p?.routeName;
  return typeof cand === 'string' ? cand : undefined;
}

function appOf(events: AgentEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const a = events[i].args as { appId?: unknown; bundleId?: unknown; bundle?: unknown };
    const id = a.appId ?? a.bundleId ?? a.bundle;
    if (typeof id === 'string' && id) return id;
  }
  return undefined;
}

interface E2eProgress {
  completed: number;
  total: number;
  lastTestId: string;
}

interface E2eFlowResult {
  testId: string;
  passed: boolean;
  classification: string;
}

interface E2eRunResult {
  ok?: boolean;
  data?: {
    runId?: string | null;
    verdict?: string | null;
    totals?: { total: number; passed: number; failed: number; skipped: number };
    results?: E2eFlowResult[];
    newlyFailing?: string[];
  };
}

interface E2eRunIndexEntry {
  runId: string;
  finishedAt: string;
  verdict: string;
  totals: { total: number; passed: number; failed: number; skipped: number };
}

function App(): JSX.Element {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [conn, setConn] = useState<'connecting' | 'open' | 'error'>('connecting');
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<'route' | 'store' | 'tree'>('route');
  const [liveShotSeq, setLiveShotSeq] = useState<number | null>(null);
  const [liveRoute, setLiveRoute] = useState<string | null>(null);
  const [view, setView] = useState<'live' | 'regression'>('live');
  const [e2eProgress, setE2eProgress] = useState<E2eProgress | null>(null);
  const [e2eRunning, setE2eRunning] = useState(false);
  const [e2eResult, setE2eResult] = useState<E2eRunResult | null>(null);
  const [e2eHistory, setE2eHistory] = useState<E2eRunIndexEntry[]>([]);
  const maxSeqRef = useRef(0);
  const timelineRef = useRef<HTMLDivElement>(null);

  const fetchE2eHistory = async (): Promise<void> => {
    try {
      const r = await fetch('/api/e2e/runs');
      if (r.ok) setE2eHistory((await r.json()) as E2eRunIndexEntry[]);
    } catch {
      /* non-fatal */
    }
  };

  useEffect(() => {
    if (view === 'regression') void fetchE2eHistory();
  }, [view]);

  const runE2eSuite = async (): Promise<void> => {
    setE2eRunning(true);
    setE2eProgress(null);
    setE2eResult(null);
    try {
      const r = await fetch('/api/e2e/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': (window as unknown as { __E2E_CSRF__?: string }).__E2E_CSRF__ ?? '',
        },
        body: '{}',
      });
      const d = (await r.json()) as E2eRunResult;
      setE2eResult(d);
      await fetchE2eHistory();
    } catch {
      /* non-fatal */
    } finally {
      setE2eRunning(false);
    }
  };

  useEffect(() => {
    const merge = (incoming: AgentEvent[]): void => {
      const fresh = incoming.filter(
        (e) => e && typeof e.seq === 'number' && e.seq > maxSeqRef.current,
      );
      if (fresh.length === 0) return;
      for (const e of fresh) if (e.seq > maxSeqRef.current) maxSeqRef.current = e.seq;
      setEvents((prev) => {
        const next = prev.concat(fresh);
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
      });
    };

    const es = new EventSource('/api/stream');
    es.onopen = () => setConn('open');
    es.onerror = () => setConn('error');
    es.onmessage = (msg) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        return;
      }
      const type =
        parsed && typeof parsed === 'object' ? (parsed as { type?: string }).type : undefined;
      if (type === 'shutdown') {
        es.close();
        setConn('error');
        setLiveShotSeq(null);
        setLiveRoute(null);
        return;
      }
      if (type === 'live') {
        const p = parsed as { shotSeq?: number; route?: string };
        if (typeof p.shotSeq === 'number') setLiveShotSeq(p.shotSeq);
        if (typeof p.route === 'string') setLiveRoute(p.route);
        return;
      }
      if (type === 'e2e-progress') {
        const p = parsed as { completed?: number; total?: number; lastTestId?: string };
        setE2eProgress({
          completed: p.completed ?? 0,
          total: p.total ?? 0,
          lastTestId: p.lastTestId ?? '',
        });
        return;
      }
      if (type === 'e2e-done') {
        setE2eProgress(null);
        void fetchE2eHistory();
        return;
      }
      if (type === 'snapshot') {
        merge((parsed as { events?: AgentEvent[] }).events ?? []);
      } else {
        merge([parsed as AgentEvent]);
      }
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  const visibleRows = useMemo(
    () => (events.length > RENDER_ROWS ? events.slice(events.length - RENDER_ROWS) : events),
    [events],
  );

  const navEv =
    latestByTool(events, ['cdp_navigation_state']) ?? latestByFamily(events, 'navigation');
  const storeEv = latestByTool(events, ['cdp_store_state']);
  const treeEv = latestByTool(events, ['cdp_component_tree']);
  const shotEv = useMemo(
    () =>
      [...events]
        .reverse()
        .find((e) => e.family === 'introspection' && e.tool === 'device_screenshot'),
    [events],
  );
  const route = routeOf(navEv);
  const app = appOf(events);

  const tabEv = tab === 'route' ? navEv : tab === 'store' ? storeEv : treeEv;

  const verdict = e2eResult?.data?.verdict;
  const newlyFailing = e2eResult?.data?.newlyFailing ?? [];

  return (
    <div className="app">
      <div className="statusbar">
        <span className={`dot ${conn}`} />
        <strong>{conn}</strong>
        <span className="sep">events {events.length}</span>
        <span className="sep">route {liveRoute ?? route ?? '—'}</span>
        {app && <span className="sep">app {app}</span>}
        <span className="view-toggle">
          <button className={view === 'live' ? 'tab on' : 'tab'} onClick={() => setView('live')}>
            Live
          </button>
          <button
            className={view === 'regression' ? 'tab on' : 'tab'}
            onClick={() => setView('regression')}
          >
            Regression
          </button>
        </span>
      </div>
      {view === 'live' ? (
        <div className="panes">
          <div className="pane left">
            <div className="pane-head">Timeline</div>
            <div className="timeline" ref={timelineRef}>
              {visibleRows.map((e) => (
                <div key={e.seq}>
                  <div
                    className={`row ${selected === e.seq ? 'sel' : ''}`}
                    onClick={() => setSelected(selected === e.seq ? null : e.seq)}
                  >
                    <span className="fam" style={{ background: FAMILY_COLOR[e.family] }}>
                      {e.family.slice(0, 4)}
                    </span>
                    <span className="tool">{e.tool}</span>
                    <span className="summ">{e.summary}</span>
                    {e.ghost && <span className="ghost">ghost</span>}
                    <span className={`ok ${e.ok ? 'pass' : 'fail'}`}>{e.ok ? '✓' : '✗'}</span>
                    {e.durationMs != null && <span className="dur">{e.durationMs}ms</span>}
                  </div>
                  {selected === e.seq && (
                    <div className="detail">
                      <div className="dlabel">args</div>
                      <pre>{pretty(e.args)}</pre>
                      {e.error && (
                        <>
                          <div className="dlabel">error</div>
                          <pre className="err">{pretty(e.error)}</pre>
                        </>
                      )}
                      {e.payload !== undefined && (
                        <>
                          <div className="dlabel">payload{e.truncated ? ' (truncated)' : ''}</div>
                          <pre>{pretty(e.payload)}</pre>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {events.length === 0 && <div className="empty">waiting for events…</div>}
            </div>
          </div>
          <div className="pane center">
            <div className="pane-head">Device</div>
            <div className="screen">
              {liveShotSeq != null ? (
                <img src={`/api/live-screenshot/${liveShotSeq}`} alt="live device screenshot" />
              ) : shotEv ? (
                <img src={`/api/screenshot/${shotEv.seq}`} alt={`screenshot seq ${shotEv.seq}`} />
              ) : (
                <div className="empty">no screenshot yet</div>
              )}
            </div>
          </div>
          <div className="pane right">
            <div className="tabs">
              {(['route', 'store', 'tree'] as const).map((t) => (
                <button key={t} className={tab === t ? 'tab on' : 'tab'} onClick={() => setTab(t)}>
                  {t}
                </button>
              ))}
            </div>
            <div className="state">
              {tab === 'route' && liveRoute && (
                <div className="liveroute">live route: {liveRoute}</div>
              )}
              {tabEv ? (
                <>
                  {tabEv.truncated && <div className="trunc">payload truncated</div>}
                  <pre>{pretty(tabEv.payload)}</pre>
                </>
              ) : tab === 'route' && liveRoute ? null : (
                <div className="empty">no {tab} captured yet</div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="reg-container">
          <div className="reg-panel">
            <div className="reg-header">
              <button
                className="reg-run-btn"
                disabled={e2eRunning}
                onClick={() => void runE2eSuite()}
              >
                {e2eRunning ? 'Running…' : 'Run E2E Suite'}
              </button>
              {e2eProgress && (
                <span className="reg-progress">
                  test {e2eProgress.completed}/{e2eProgress.total} — {e2eProgress.lastTestId}
                </span>
              )}
              {verdict && (
                <span className={`reg-verdict ${verdict === 'green' ? 'pass' : 'fail'}`}>
                  {verdict === 'green' ? 'PASS' : 'FAIL'}
                </span>
              )}
            </div>
            {e2eResult?.data?.results && e2eResult.data.results.length > 0 && (
              <div className="reg-results">
                <table className="reg-table">
                  <thead>
                    <tr>
                      <th>Test ID</th>
                      <th>Result</th>
                      <th>Classification</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e2eResult.data.results.map((r) => (
                      <tr
                        key={r.testId}
                        className={newlyFailing.includes(r.testId) ? 'reg-newly-failing' : ''}
                      >
                        <td className="reg-testid">{r.testId}</td>
                        <td className={r.passed ? 'reg-pass' : 'reg-fail'}>
                          {r.passed ? 'pass' : 'fail'}
                        </td>
                        <td>
                          <span className={`reg-badge reg-badge-${r.classification}`}>
                            {r.classification}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="reg-history">
            <div className="pane-head">Run History</div>
            {e2eHistory.length === 0 ? (
              <div className="empty">no runs yet</div>
            ) : (
              <table className="reg-table">
                <thead>
                  <tr>
                    <th>Run ID</th>
                    <th>Finished</th>
                    <th>Verdict</th>
                    <th>Pass/Fail/Skip</th>
                  </tr>
                </thead>
                <tbody>
                  {e2eHistory.map((h) => (
                    <tr key={h.runId}>
                      <td className="reg-testid">{h.runId}</td>
                      <td>{new Date(h.finishedAt).toLocaleTimeString()}</td>
                      <td className={h.verdict === 'green' ? 'reg-pass' : 'reg-fail'}>
                        {h.verdict === 'green' ? 'PASS' : 'FAIL'}
                      </td>
                      <td>
                        {h.totals.passed}/{h.totals.failed}/{h.totals.skipped}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const CSS = `
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: #1a1b26; color: #c0caf5;
  font: 13px -apple-system, system-ui, sans-serif;
}
pre, .tool, .dur, .summ { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.app { display: flex; flex-direction: column; height: 100%; }
.statusbar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px; background: #16161e; border-bottom: 1px solid #2a2b3d;
}
.statusbar .sep { color: #787c99; margin-left: 10px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #787c99; }
.dot.open { background: #9ece6a; }
.dot.connecting { background: #e0af68; }
.dot.error { background: #f7768e; }
.view-toggle { margin-left: auto; display: flex; gap: 4px; }
.panes { display: flex; flex: 1; min-height: 0; }
.pane { display: flex; flex-direction: column; min-width: 0; border-right: 1px solid #2a2b3d; }
.pane.left { flex: 0 0 38%; }
.pane.center { flex: 1; }
.pane.right { flex: 0 0 28%; border-right: none; }
.pane-head, .tabs { padding: 6px 10px; background: #16161e; border-bottom: 1px solid #2a2b3d; font-weight: 600; }
.timeline { flex: 1; overflow: auto; padding: 4px 0; }
.row {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 10px; cursor: pointer; white-space: nowrap;
}
.row:hover { background: #1f2335; }
.row.sel { background: #283457; }
.fam { color: #16161e; border-radius: 3px; padding: 0 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
.tool { color: #7dcfff; }
.summ { color: #a9b1d6; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.ghost { color: #16161e; background: #e0af68; border-radius: 3px; padding: 0 4px; font-size: 10px; font-weight: 700; }
.ok.pass { color: #9ece6a; } .ok.fail { color: #f7768e; }
.dur { color: #565f89; }
.detail { background: #13141c; border-top: 1px solid #2a2b3d; border-bottom: 1px solid #2a2b3d; padding: 6px 10px; }
.dlabel { color: #787c99; text-transform: uppercase; font-size: 10px; margin: 4px 0 2px; }
.detail pre, .state pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
.detail pre.err { color: #f7768e; }
.screen { flex: 1; overflow: auto; display: flex; align-items: flex-start; justify-content: center; padding: 12px; }
.screen img { max-width: 100%; height: auto; border: 1px solid #2a2b3d; border-radius: 4px; }
.tabs { display: flex; gap: 6px; padding: 6px 8px; }
.tab { background: #1f2335; color: #a9b1d6; border: 1px solid #2a2b3d; border-radius: 4px; padding: 3px 10px; cursor: pointer; font: inherit; }
.tab.on { background: #283457; color: #c0caf5; }
.state { flex: 1; overflow: auto; padding: 8px 10px; }
.trunc { color: #e0af68; font-size: 11px; margin-bottom: 6px; }
.liveroute { color: #9ece6a; font-weight: 600; margin-bottom: 6px; }
.empty { color: #565f89; padding: 12px; }
.reg-container { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto; padding: 16px; gap: 16px; }
.reg-panel { background: #16161e; border: 1px solid #2a2b3d; border-radius: 6px; padding: 14px; }
.reg-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.reg-run-btn { background: #283457; color: #c0caf5; border: 1px solid #2a2b3d; border-radius: 4px; padding: 6px 16px; cursor: pointer; font: inherit; font-weight: 600; }
.reg-run-btn:hover:not(:disabled) { background: #3b4261; }
.reg-run-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.reg-progress { color: #e0af68; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
.reg-verdict { font-weight: 700; border-radius: 4px; padding: 3px 10px; font-size: 13px; }
.reg-verdict.pass { background: #1a2d1a; color: #9ece6a; border: 1px solid #9ece6a; }
.reg-verdict.fail { background: #2d1a1a; color: #f7768e; border: 1px solid #f7768e; }
.reg-results { overflow: auto; }
.reg-history { background: #16161e; border: 1px solid #2a2b3d; border-radius: 6px; overflow: auto; }
.reg-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.reg-table th { padding: 6px 10px; text-align: left; background: #13141c; color: #787c99; font-weight: 600; border-bottom: 1px solid #2a2b3d; }
.reg-table td { padding: 5px 10px; border-bottom: 1px solid #1f2335; }
.reg-table tr:last-child td { border-bottom: none; }
.reg-table tr:hover td { background: #1f2335; }
.reg-testid { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #7dcfff; }
.reg-pass { color: #9ece6a; font-weight: 600; }
.reg-fail { color: #f7768e; font-weight: 600; }
.reg-newly-failing td { background: #2d1a1a !important; }
.reg-badge { border-radius: 3px; padding: 1px 5px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
.reg-badge-pass { background: #1a2d1a; color: #9ece6a; }
.reg-badge-regression { background: #2d1a1a; color: #f7768e; }
.reg-badge-infra { background: #2d2a1a; color: #e0af68; }
.reg-badge-skipped { background: #1f2335; color: #787c99; }
`;

const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
