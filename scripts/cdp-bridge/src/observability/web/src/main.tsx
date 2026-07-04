import { useMemo, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentEvent, Family } from './types';
import { CSS, FAMILIES } from './theme';
import { appOf, latestByFamily, latestByTool, routeOf } from './derive';
import { useEventStream } from './hooks/useEventStream';
import { Header, type View } from './components/Header';
import { FilterBar } from './components/FilterBar';
import { Timeline } from './components/Timeline';
import { DevicePane } from './components/DevicePane';
import { StatePane } from './components/StatePane';
import { RegressionView } from './components/RegressionView';

const RENDER_ROWS = 250;

function App(): JSX.Element {
  const { events, conn, liveShotSeq, liveRoute, e2eProgress, e2eDoneCount, mirror } =
    useEventStream();
  const [view, setView] = useState<View>('live');
  const [selected, setSelected] = useState<number | null>(null);
  const [activeFamilies, setActiveFamilies] = useState<ReadonlySet<Family>>(new Set(FAMILIES));
  const [search, setSearch] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);

  const toggleFamily = (f: Family): void => {
    setActiveFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };

  const counts = useMemo(() => {
    const c = Object.fromEntries(FAMILIES.map((f) => [f, 0])) as Record<Family, number>;
    for (const e of events) c[e.family] = (c[e.family] ?? 0) + 1;
    return c;
  }, [events]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (e: AgentEvent): boolean => {
      if (!activeFamilies.has(e.family)) return false;
      if (errorsOnly && e.ok) return false;
      if (q && !e.tool.toLowerCase().includes(q) && !e.summary.toLowerCase().includes(q))
        return false;
      return true;
    };
    const out = events.filter(match);
    return out.length > RENDER_ROWS ? out.slice(out.length - RENDER_ROWS) : out;
  }, [events, activeFamilies, search, errorsOnly]);

  const navEv =
    latestByTool(events, ['cdp_navigation_state']) ?? latestByFamily(events, 'navigation');
  const storeEv = latestByTool(events, ['cdp_store_state']);
  const treeEv = latestByTool(events, ['cdp_component_tree']);
  const shotEv = latestByTool(events, ['device_screenshot']);
  const route = liveRoute ?? routeOf(navEv) ?? null;
  const app = appOf(events);

  return (
    <div className="app">
      <Header
        conn={conn}
        app={app}
        route={route ?? undefined}
        events={events}
        view={view}
        onViewChange={setView}
      />
      {view === 'live' ? (
        <div className="panes">
          <div className="pane left">
            <FilterBar
              counts={counts}
              active={activeFamilies}
              onToggleFamily={toggleFamily}
              search={search}
              onSearch={setSearch}
              errorsOnly={errorsOnly}
              onErrorsOnly={setErrorsOnly}
            />
            <Timeline
              events={filtered}
              totalCount={events.length}
              selected={selected}
              onSelect={setSelected}
            />
          </div>
          <DevicePane
            mirror={mirror}
            liveShotSeq={liveShotSeq}
            fallbackSeq={shotEv && shotEv.ok ? shotEv.seq : null}
            route={route}
          />
          <StatePane navEv={navEv} storeEv={storeEv} treeEv={treeEv} liveRoute={liveRoute} />
        </div>
      ) : (
        <RegressionView e2eProgress={e2eProgress} e2eDoneCount={e2eDoneCount} />
      )}
    </div>
  );
}

const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
