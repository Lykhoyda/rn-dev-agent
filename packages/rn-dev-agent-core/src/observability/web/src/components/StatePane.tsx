import { useEffect, useState, type JSX } from 'react';
import type { ActionSummary, AgentEvent, E2eProgress } from '../types';
import { pretty } from '../derive';
import { ActionsPanel } from './ActionsPanel';
import { E2ePanel } from './E2ePanel';

type Tab = 'route' | 'store' | 'tree' | 'actions' | 'e2e';

const PAYLOAD_TABS = ['route', 'store', 'tree'] as const;
type PayloadTab = (typeof PAYLOAD_TABS)[number];

const EMPTY_HINT: Record<PayloadTab, string> = {
  route: 'no navigation state yet — run cdp_navigation_state',
  store: 'no store snapshot yet — run cdp_store_state',
  tree: 'no component tree yet — run cdp_component_tree',
};

function isPayloadTab(t: Tab): t is PayloadTab {
  return (PAYLOAD_TABS as readonly Tab[]).includes(t);
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
  const tabEv =
    tab === 'route' ? navEv : tab === 'store' ? storeEv : tab === 'tree' ? treeEv : undefined;

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

  return (
    <div className="pane right">
      <div className="tabs">
        {(['route', 'store', 'tree', 'actions', 'e2e'] as const).map((t) => (
          <button key={t} className={tab === t ? 'tab on' : 'tab'} onClick={() => setTab(t)}>
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
          {tab === 'route' && liveRoute && <div className="liveroute">live route: {liveRoute}</div>}
          {tabEv ? (
            <>
              {tabEv.truncated && <div className="trunc">payload truncated</div>}
              <pre>{pretty(tabEv.payload)}</pre>
            </>
          ) : tab === 'route' && liveRoute ? null : isPayloadTab(tab) ? (
            <div className="empty">{EMPTY_HINT[tab]}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
