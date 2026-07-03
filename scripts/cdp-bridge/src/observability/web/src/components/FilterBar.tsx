import type { JSX } from 'react';
import type { Family } from '../types';
import { FAMILIES, FAMILY_COLOR } from '../theme';

interface FilterBarProps {
  counts: Record<Family, number>;
  active: ReadonlySet<Family>;
  onToggleFamily: (f: Family) => void;
  search: string;
  onSearch: (q: string) => void;
  errorsOnly: boolean;
  onErrorsOnly: (on: boolean) => void;
}

export function FilterBar({
  counts,
  active,
  onToggleFamily,
  search,
  onSearch,
  errorsOnly,
  onErrorsOnly,
}: FilterBarProps): JSX.Element {
  return (
    <div className="filterbar">
      {FAMILIES.map((f) => (
        <button
          key={f}
          className={active.has(f) ? 'fchip' : 'fchip off'}
          onClick={() => onToggleFamily(f)}
          title={`toggle ${f} events`}
        >
          <span className="fdot" style={{ background: FAMILY_COLOR[f] }} />
          {f}
          <span className="n">{counts[f] ?? 0}</span>
        </button>
      ))}
      <button
        className={errorsOnly ? 'fchip errors on' : 'fchip errors'}
        onClick={() => onErrorsOnly(!errorsOnly)}
        title="only failed calls"
      >
        ✗ errors
      </button>
      <input
        className="search"
        placeholder="search tool or summary…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
    </div>
  );
}
