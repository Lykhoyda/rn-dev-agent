import { useState, type JSX } from 'react';
import type { ActionRunState, ActionSummary } from '../types';
import { csrfToken } from '../derive';

interface ActionsPanelProps {
  actions: ActionSummary[];
}

export function ActionsPanel({ actions }: ActionsPanelProps): JSX.Element {
  const [states, setStates] = useState<Record<string, ActionRunState>>({});
  const [paramValues, setParamValues] = useState<Record<string, Record<string, string>>>({});
  const [openOutput, setOpenOutput] = useState<string | null>(null);

  const setParam = (actionId: string, key: string, value: string): void => {
    setParamValues((prev) => ({ ...prev, [actionId]: { ...prev[actionId], [key]: value } }));
  };

  const run = async (a: ActionSummary): Promise<void> => {
    setStates((prev) => ({ ...prev, [a.id]: { running: true } }));
    try {
      const r = await fetch('/api/e2e/actions/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ actionId: a.id, params: paramValues[a.id] ?? {} }),
      });
      const result = (await r.json()) as ActionRunState['result'];
      setStates((prev) => ({ ...prev, [a.id]: { running: false, result } }));
      if (result && (!result.ok || result.output)) setOpenOutput(a.id);
    } catch {
      setStates((prev) => ({
        ...prev,
        [a.id]: { running: false, result: { ok: false, error: 'network error' } },
      }));
    }
  };

  return (
    <div className="actions-panel">
      <div className="pane-head">Actions</div>
      {actions.length === 0 ? (
        <div className="empty empty-guide">
          <div className="empty-title">No learned actions</div>
          <div>Save a verified flow with cdp_record_test_save_as_action and it appears here.</div>
        </div>
      ) : (
        <table className="reg-table actions-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Intent</th>
              <th>Status</th>
              <th>Params</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => {
              const st = states[a.id];
              const missing = st?.result?.missingParams ?? [];
              return (
                <ActionRow
                  key={a.id}
                  action={a}
                  state={st}
                  missing={missing}
                  values={paramValues[a.id] ?? {}}
                  onParam={(k, v) => setParam(a.id, k, v)}
                  onRun={() => void run(a)}
                  outputOpen={openOutput === a.id}
                  onToggleOutput={() => setOpenOutput(openOutput === a.id ? null : a.id)}
                />
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface ActionRowProps {
  action: ActionSummary;
  state?: ActionRunState;
  missing: string[];
  values: Record<string, string>;
  onParam: (key: string, value: string) => void;
  onRun: () => void;
  outputOpen: boolean;
  onToggleOutput: () => void;
}

function ActionRow({
  action: a,
  state: st,
  missing,
  values,
  onParam,
  onRun,
  outputOpen,
  onToggleOutput,
}: ActionRowProps): JSX.Element {
  const res = st?.result;
  return (
    <>
      <tr>
        <td className="reg-testid">{a.id}</td>
        <td className="actions-intent" title={a.intent}>
          {a.intent}
        </td>
        <td>
          <span className={`reg-badge actions-status-${a.status}`}>{a.status}</span>
          {a.mutates && (
            <span className="actions-mutates" title="mutates state">
              M
            </span>
          )}
        </td>
        <td>
          <span className="actions-params">
            {(a.params ?? []).map((p) => (
              <input
                key={p}
                className={missing.includes(p) ? 'param-input missing' : 'param-input'}
                placeholder={p}
                value={values[p] ?? ''}
                onChange={(e) => onParam(p, e.target.value)}
              />
            ))}
          </span>
        </td>
        <td className="actions-run-cell">
          <button className="actions-run-btn" disabled={st?.running} onClick={onRun}>
            {st?.running ? '…' : 'Run'}
          </button>
          {res && (
            <span
              className={res.ok ? 'actions-result-ok' : 'actions-result-fail'}
              onClick={onToggleOutput}
              title="show output"
            >
              {res.ok
                ? '✓ output'
                : res.missingParams
                  ? `missing: ${res.missingParams.join(', ')}`
                  : (res.error ?? 'failed')}
            </span>
          )}
        </td>
      </tr>
      {outputOpen && res && (res.output || res.error) && (
        <tr className="action-output">
          <td colSpan={5}>
            <pre>{res.output ?? res.error}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
