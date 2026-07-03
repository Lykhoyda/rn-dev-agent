import { useState, type JSX } from 'react';
import type { AgentEvent } from '../types';
import { pretty } from '../derive';

type Tab = 'route' | 'store' | 'tree';

const EMPTY_HINT: Record<Tab, string> = {
  route: 'no navigation state yet — run cdp_navigation_state',
  store: 'no store snapshot yet — run cdp_store_state',
  tree: 'no component tree yet — run cdp_component_tree',
};

interface StatePaneProps {
  navEv?: AgentEvent;
  storeEv?: AgentEvent;
  treeEv?: AgentEvent;
  liveRoute: string | null;
}

export function StatePane({ navEv, storeEv, treeEv, liveRoute }: StatePaneProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('route');
  const tabEv = tab === 'route' ? navEv : tab === 'store' ? storeEv : treeEv;

  return (
    <div className="pane right">
      <div className="tabs">
        {(['route', 'store', 'tree'] as const).map((t) => (
          <button key={t} className={tab === t ? 'tab on' : 'tab'} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="state">
        {tab === 'route' && liveRoute && <div className="liveroute">live route: {liveRoute}</div>}
        {tabEv ? (
          <>
            {tabEv.truncated && <div className="trunc">payload truncated</div>}
            <pre>{pretty(tabEv.payload)}</pre>
          </>
        ) : tab === 'route' && liveRoute ? null : (
          <div className="empty">{EMPTY_HINT[tab]}</div>
        )}
      </div>
    </div>
  );
}
