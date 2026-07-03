import { useEffect, useState, type JSX } from 'react';
import type { AgentEvent, Conn } from '../types';
import { fmtElapsed } from '../derive';

export type View = 'live' | 'regression';

interface HeaderProps {
  conn: Conn;
  app?: string;
  route?: string;
  events: AgentEvent[];
  view: View;
  onViewChange: (v: View) => void;
}

export function Header({ conn, app, route, events, view, onViewChange }: HeaderProps): JSX.Element {
  const startTs = events.length > 0 ? events[0].ts : null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (startTs == null) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [startTs]);

  const errors = events.reduce((n, e) => (e.ok ? n : n + 1), 0);

  return (
    <div className="header">
      <div className="brand">
        <strong>Observe</strong>
        <span>rn-dev-agent</span>
      </div>
      <span className="conn-pill">
        <span className={`dot ${conn}`} />
        {conn === 'open' ? 'live' : conn}
      </span>
      {app && (
        <span className="chip" title={app}>
          <b>app</b>
          {app}
        </span>
      )}
      {route && (
        <span className="chip route" title={route}>
          <b>route</b>
          {route}
        </span>
      )}
      <div className="hstats">
        {startTs != null && (
          <span className="stat">
            <span className="v">{fmtElapsed(Date.now() - startTs)}</span>
            <span className="k">session</span>
          </span>
        )}
        <span className="stat">
          <span className="v">{events.length}</span>
          <span className="k">calls</span>
        </span>
        <span className="stat">
          <span className={errors > 0 ? 'v bad' : 'v'}>{errors}</span>
          <span className="k">errors</span>
        </span>
        <span className="view-toggle">
          <button className={view === 'live' ? 'tab on' : 'tab'} onClick={() => onViewChange('live')}>
            Live
          </button>
          <button
            className={view === 'regression' ? 'tab on' : 'tab'}
            onClick={() => onViewChange('regression')}
          >
            Regression
          </button>
        </span>
      </div>
    </div>
  );
}
