import { useEffect, useState, type JSX } from 'react';
import type { E2eProgress, E2eRunDetail, E2eRunIndexEntry, E2eRunResult } from '../types';
import { csrfToken } from '../derive';

interface E2ePanelProps {
  e2eProgress: E2eProgress | null;
  /** From useEventStream — bumps when a suite finishes anywhere (tool or UI). */
  e2eDoneCount: number;
}

export function E2ePanel({ e2eProgress, e2eDoneCount }: E2ePanelProps): JSX.Element {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<E2eRunResult | null>(null);
  const [history, setHistory] = useState<E2eRunIndexEntry[]>([]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [runDetails, setRunDetails] = useState<Record<string, E2eRunDetail | 'loading' | 'error'>>(
    {},
  );

  const fetchHistory = async (): Promise<void> => {
    try {
      const r = await fetch('/api/e2e/runs');
      if (r.ok) setHistory((await r.json()) as E2eRunIndexEntry[]);
    } catch {
      /* non-fatal */
    }
  };

  useEffect(() => {
    void fetchHistory();
  }, [e2eDoneCount]);

  const toggleRun = (runId: string): void => {
    const next = openRun === runId ? null : runId;
    setOpenRun(next);
    if (next && runDetails[next] === undefined) {
      setRunDetails((prev) => ({ ...prev, [next]: 'loading' }));
      fetch(`/api/e2e/runs/${encodeURIComponent(next)}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          const detail = (await r.json()) as E2eRunDetail;
          setRunDetails((prev) => ({ ...prev, [next]: detail }));
        })
        .catch(() => {
          setRunDetails((prev) => ({ ...prev, [next]: 'error' }));
        });
    }
  };

  const runSuite = async (): Promise<void> => {
    setRunning(true);
    setResult(null);
    try {
      const r = await fetch('/api/e2e/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: '{}',
      });
      setResult((await r.json()) as E2eRunResult);
      await fetchHistory();
    } catch {
      /* non-fatal */
    } finally {
      setRunning(false);
    }
  };

  const verdict = result?.data?.verdict;
  const newlyFailing = result?.data?.newlyFailing ?? [];

  return (
    <div className="reg-container">
      <div className="reg-panel">
        <div className="reg-header">
          <button className="reg-run-btn" disabled={running} onClick={() => void runSuite()}>
            {running ? 'Running…' : 'Run E2E Suite'}
          </button>
          {e2eProgress && (
            <span className="reg-progress mono">
              test {e2eProgress.completed}/{e2eProgress.total} — {e2eProgress.lastTestId}
            </span>
          )}
          {verdict && (
            <span
              className={`reg-verdict ${verdict === 'green' ? 'pass' : verdict === 'empty' ? 'none' : 'fail'}`}
            >
              {verdict === 'green' ? 'PASS' : verdict === 'empty' ? 'NO TESTS' : 'FAIL'}
            </span>
          )}
          {verdict === 'empty' && (
            <span className="reg-empty-hint">
              No locked tests — lock one with cdp_lock_e2e_test
            </span>
          )}
        </div>
        {result?.data?.results && result.data.results.length > 0 && (
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
                {result.data.results.map((r) => (
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
        {history.length === 0 ? (
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
              {history.map((h) => (
                <HistoryRow
                  key={h.runId}
                  entry={h}
                  open={openRun === h.runId}
                  detail={runDetails[h.runId]}
                  onToggle={() => toggleRun(h.runId)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface HistoryRowProps {
  entry: E2eRunIndexEntry;
  open: boolean;
  detail?: E2eRunDetail | 'loading' | 'error';
  onToggle: () => void;
}

function HistoryRow({ entry: h, open, detail, onToggle }: HistoryRowProps): JSX.Element {
  return (
    <>
      <tr className="hist-row" onClick={onToggle}>
        <td className="reg-testid">
          {open ? '▾ ' : '▸ '}
          {h.runId}
        </td>
        <td>{new Date(h.finishedAt).toLocaleTimeString()}</td>
        <td
          className={
            h.verdict === 'green' ? 'reg-pass' : h.verdict === 'empty' ? 'reg-none' : 'reg-fail'
          }
        >
          {h.verdict === 'green' ? 'PASS' : h.verdict === 'empty' ? 'NO TESTS' : 'FAIL'}
        </td>
        <td>
          {h.totals.passed}/{h.totals.failed}/{h.totals.skipped}
        </td>
      </tr>
      {open && (
        <tr className="hist-detail">
          <td colSpan={4}>
            {detail === 'loading' || detail === undefined ? (
              <div className="empty">loading run…</div>
            ) : detail === 'error' ? (
              <div className="empty">failed to load run detail</div>
            ) : (
              <>
                <div className="hist-meta mono">
                  {detail.platform} · {Math.round(detail.durationMs / 1000)}s ·{' '}
                  {new Date(detail.startedAt).toLocaleTimeString()} →{' '}
                  {new Date(detail.finishedAt).toLocaleTimeString()}
                </div>
                {detail.results.map((r) => (
                  <div key={r.testId}>
                    <span className={r.passed ? 'reg-pass' : 'reg-fail'}>
                      {r.passed ? '✓' : '✗'}
                    </span>{' '}
                    <span className="reg-testid">{r.testId}</span>{' '}
                    <span className={`reg-badge reg-badge-${r.classification}`}>
                      {r.classification}
                    </span>
                    {r.durationMs != null && <span className="mono"> {r.durationMs}ms</span>}
                    {r.errorExcerpt && <div className="errx">{r.errorExcerpt}</div>}
                  </div>
                ))}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
