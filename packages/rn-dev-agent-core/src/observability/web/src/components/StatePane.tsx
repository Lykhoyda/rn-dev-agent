import { useCallback, useEffect, useState, type JSX } from 'react';
import type { ActionSummary, AgentEvent, E2eProgress } from '../types';
import { fmtClock, pretty } from '../derive';
import { ActionsPanel } from './ActionsPanel';
import { E2ePanel } from './E2ePanel';

type Tab = 'route' | 'store' | 'tree' | 'actions' | 'e2e';

const PAYLOAD_TABS = ['route', 'store', 'tree'] as const;
type PayloadTab = (typeof PAYLOAD_TABS)[number];

const EMPTY_HINT: Record<PayloadTab, string> = {
  route: 'no navigation state yet · run cdp_navigation_state',
  store: 'no store snapshot yet · run cdp_store_state',
  tree: 'no component tree yet · run cdp_component_tree',
};

function isPayloadTab(t: Tab): t is PayloadTab {
  return (PAYLOAD_TABS as readonly Tab[]).includes(t);
}

/** GH #579: client-side record of a GET /api/state/<kind> live read. */
interface FetchedState {
  at: number;
  ok: boolean;
  payload?: unknown;
  error?: string;
  truncated?: boolean;
}

interface StatePaneProps {
  navEv?: AgentEvent;
  storeEv?: AgentEvent;
  treeEv?: AgentEvent;
  liveRoute: string | null;
  e2eProgress: E2eProgress | null;
  /** From useEventStream — bumps when a suite finishes anywhere (tool or UI). */
  e2eDoneCount: number;
}

export function StatePane({
  navEv,
  storeEv,
  treeEv,
  liveRoute,
  e2eProgress,
  e2eDoneCount,
}: StatePaneProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('route');
  const [actions, setActions] = useState<ActionSummary[]>([]);
  // GH #579: the panels used to render ONLY past tool events, so a healthy
  // session where the agent never ran the introspection tools showed empty
  // panels forever. Each payload tab now auto-fetches a live read the first
  // time it is shown empty, and a refresh button re-reads on demand (also the
  // recovery path after a reload/reconnect leaves event data stale).
  const [fetched, setFetched] = useState<Partial<Record<PayloadTab, FetchedState>>>({});
  const [loading, setLoading] = useState<PayloadTab | null>(null);
  const tabEv =
    tab === 'route' ? navEv : tab === 'store' ? storeEv : tab === 'tree' ? treeEv : undefined;

  const refresh = useCallback(async (t: PayloadTab): Promise<void> => {
    // Stamp with the REQUEST time, not the response time: a slow live read
    // that started before a newer tool event lands must not outrank it in the
    // freshness comparison below.
    const at = Date.now();
    setLoading(t);
    try {
      const r = await fetch(`/api/state/${t}`);
      const env = (await r.json()) as {
        ok?: boolean;
        data?: unknown;
        error?: string;
        truncated?: boolean;
      };
      setFetched((prev) => ({
        ...prev,
        [t]: env.ok
          ? { at, ok: true, payload: env.data, truncated: env.truncated }
          : { at, ok: false, error: env.error ?? `HTTP ${r.status}` },
      }));
    } catch (e) {
      setFetched((prev) => ({
        ...prev,
        [t]: { at, ok: false, error: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setLoading((cur) => (cur === t ? null : cur));
    }
  }, []);

  // Full emptiness inputs in the deps: if the active tab LOSES its event data
  // later (stream reset, ring-buffer churn) the auto-read must re-arm, not
  // wait for a manual refresh. No loop: a completed read — ok or failed —
  // lands in `fetched[tab]` and disarms the effect.
  useEffect(() => {
    if (!isPayloadTab(tab) || tabEv || fetched[tab] || loading === tab) return;
    void refresh(tab);
  }, [tab, tabEv, fetched, loading, refresh]);

  useEffect(() => {
    const fetchActions = async (): Promise<void> => {
      try {
        const r = await fetch('/api/e2e/actions');
        if (r.ok) setActions((await r.json()) as ActionSummary[]);
      } catch {
        /* non-fatal */
      }
    };
    void fetchActions();
  }, [e2eDoneCount]);

  // A successful live read wins over an older (or absent) tool event; a FAILED
  // live read never hides existing event data — its error only shows when
  // there is nothing else to render.
  const f = isPayloadTab(tab) ? fetched[tab] : undefined;
  const liveWins = f?.ok === true && (!tabEv || f.at > tabEv.ts);
  const liveError = f && !f.ok && !tabEv ? (f.error ?? 'live read failed') : undefined;

  return (
    <div className="pane right" data-testid="state-pane">
      <div className="tabs">
        {(['route', 'store', 'tree', 'actions', 'e2e'] as const).map((t) => (
          <button
            key={t}
            data-testid={`state-tab-${t}`}
            className={tab === t ? 'tab on' : 'tab'}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'actions' ? (
        <div className="state-panel">
          <ActionsPanel actions={actions} />
        </div>
      ) : tab === 'e2e' ? (
        <div className="state-panel">
          <E2ePanel e2eProgress={e2eProgress} e2eDoneCount={e2eDoneCount} />
        </div>
      ) : (
        <div className="state">
          {isPayloadTab(tab) && (
            <div className="state-live-row">
              <button
                data-testid="state-refresh"
                className="state-refresh-btn"
                disabled={loading === tab}
                onClick={() => void refresh(tab)}
              >
                {loading === tab ? 'reading…' : '↻ read live'}
              </button>
              {liveWins && f && (
                <span className="state-live-at" data-testid="state-live-at">
                  live · {fmtClock(f.at)}
                </span>
              )}
            </div>
          )}
          {tab === 'route' && liveRoute && <div className="liveroute">live route: {liveRoute}</div>}
          {liveWins && f ? (
            <>
              {f.truncated && <div className="trunc">payload truncated</div>}
              <pre data-testid="state-live-payload">{pretty(f.payload)}</pre>
            </>
          ) : tabEv ? (
            <>
              {tabEv.truncated && <div className="trunc">payload truncated</div>}
              <pre>{pretty(tabEv.payload)}</pre>
            </>
          ) : tab === 'route' && liveRoute ? null : isPayloadTab(tab) ? (
            <div className="empty">
              {EMPTY_HINT[tab]}
              {liveError && (
                <div className="state-live-err" data-testid="state-live-err">
                  live read failed: {liveError}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
