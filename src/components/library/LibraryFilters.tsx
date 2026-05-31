import { withViewTransition } from '../../lib/viewTransition'
import './LibraryFilters.css'

// Sort + status filter pair, rendered as native <select> elements styled
// as pill chips. Sits above the library result grid. The available sort
// options and status values are tab-specific (TV ≠ Movies) so the parent
// passes them in.

export type FilterOption<K extends string> = {
  value: K
  label: string
}

type Props<S extends string, T extends string> = {
  sortOptions: ReadonlyArray<FilterOption<S>>
  sortValue: S
  onSortChange: (next: S) => void

  statusLabel: string
  statusOptions: ReadonlyArray<FilterOption<T>>
  statusValue: T
  onStatusChange: (next: T) => void
}

export function LibraryFilters<S extends string, T extends string>({
  sortOptions,
  sortValue,
  onSortChange,
  statusLabel,
  statusOptions,
  statusValue,
  onStatusChange,
}: Props<S, T>) {
  return (
    <div className="lib-filters">
      <label className="lib-filters__chip">
        <span className="lib-filters__label">Sort</span>
        <select
          className="lib-filters__select"
          value={sortValue}
          onChange={(e) => {
            const next = e.target.value as S
            withViewTransition(() => onSortChange(next))
          }}
          aria-label="Sort library"
        >
          {sortOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <span className="lib-filters__chevron" aria-hidden="true">{'▾'}</span>
      </label>

      <label className="lib-filters__chip">
        <span className="lib-filters__label">{statusLabel}</span>
        <select
          className="lib-filters__select"
          value={statusValue}
          onChange={(e) => {
            const next = e.target.value as T
            withViewTransition(() => onStatusChange(next))
          }}
          aria-label={`Filter by ${statusLabel.toLowerCase()}`}
        >
          {statusOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <span className="lib-filters__chevron" aria-hidden="true">{'▾'}</span>
      </label>
    </div>
  )
}
