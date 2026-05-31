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
  const p = ev.payload as { data?: { current?: string; route?: string; name?: string } } | undefined;
  const cand = p?.data?.current ?? p?.data?.route ?? p?.data?.name;
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

function App(): JSX.Element {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [conn, setConn] = useState<'connecting' | 'open' | 'error'>('connecting');
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<'route' | 'store' | 'tree'>('route');
  const maxSeqRef = useRef(0);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const merge = (incoming: AgentEvent[]): void => {
      const fresh = incoming.filter((e) => e && typeof e.seq === 'number' && e.seq > maxSeqRef.current);
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
      if (parsed && typeof parsed === 'object' && (parsed as { type?: string }).type === 'snapshot') {
        merge(((parsed as { events?: AgentEvent[] }).events) ?? []);
      } else {
        merge([parsed as AgentEvent]);
      }
    };
    return () => es.close();
  }, []);

  // Auto-scroll the timeline to the newest row.
  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  // Lightweight virtualization: only the most recent RENDER_ROWS events hit the DOM;
  // older rows are pruned from view (still held in state up to MAX_EVENTS).
  const visibleRows = useMemo(
    () => (events.length > RENDER_ROWS ? events.slice(events.length - RENDER_ROWS) : events),
    [events],
  );

  const navEv = latestByTool(events, ['cdp_navigation_state']) ?? latestByFamily(events, 'navigation');
  const storeEv = latestByTool(events, ['cdp_store_state']);
  const treeEv = latestByTool(events, ['cdp_component_tree']);
  const shotEv = useMemo(
    () =>
      [...events].reverse().find((e) => e.family === 'introspection' && e.tool === 'device_screenshot'),
    [events],
  );
  const route = routeOf(navEv);
  const app = appOf(events);
  const selectedEv = selected != null ? events.find((e) => e.seq === selected) : undefined;

  const tabEv = tab === 'route' ? navEv : tab === 'store' ? storeEv : treeEv;

  return (
    <div className="app">
      <div className="statusbar">
        <span className={`dot ${conn}`} />
        <strong>{conn}</strong>
        <span className="sep">events {events.length}</span>
        <span className="sep">route {route ?? '—'}</span>
        {app && <span className="sep">app {app}</span>}
      </div>
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
            {shotEv ? (
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
            {tabEv ? (
              <>
                {tabEv.truncated && <div className="trunc">payload truncated</div>}
                <pre>{pretty(tabEv.payload)}</pre>
              </>
            ) : (
              <div className="empty">no {tab} captured yet</div>
            )}
          </div>
        </div>
      </div>
      {selectedEv && <div className="hidden" />}
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
.empty { color: #565f89; padding: 12px; }
.hidden { display: none; }
`;

const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
