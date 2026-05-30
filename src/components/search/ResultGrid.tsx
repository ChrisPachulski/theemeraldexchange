import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import './ResultGrid.css'

// Above this many items the grid windows its rows so a large filtered library
// doesn't mount every <MediaCard> (and its lazy <img>) at once. Below it, the
// plain CSS grid is cheaper than the virtualizer's bookkeeping.
const VIRTUALIZE_THRESHOLD = 200
// Fallback row height before a row is measured. Cards are variable-height
// (title + meta + overview), so the virtualizer remeasures via measureElement;
// this only governs the very first paint and the scroll-height estimate.
const ESTIMATED_ROW_PX = 220

type ChildrenProps = { children: ReactNode }

type VirtualProps<T> = {
  items: T[]
  renderItem: (item: T) => ReactNode
  getKey: (item: T) => string | number
}

function isVirtual<T>(props: ResultGridProps<T>): props is VirtualProps<T> {
  return 'items' in props
}

export type ResultGridProps<T = unknown> = ChildrenProps | VirtualProps<T>

export function ResultGrid<T = unknown>(props: ResultGridProps<T>) {
  if (!isVirtual(props)) {
    return <div className="result-grid">{props.children}</div>
  }
  if (props.items.length <= VIRTUALIZE_THRESHOLD) {
    return (
      <div className="result-grid">
        {props.items.map((item) => (
          <ResultGridCell key={props.getKey(item)}>{props.renderItem(item)}</ResultGridCell>
        ))}
      </div>
    )
  }
  return <VirtualResultGrid {...props} />
}

function ResultGridCell({ children }: { children: ReactNode }) {
  return <>{children}</>
}

function VirtualResultGrid<T>({ items, renderItem, getKey }: VirtualProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Column count mirrors ResultGrid.css: 1 column below 640px, 2 at/above it.
  const [cols, setCols] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth >= 640 ? 2 : 1,
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const measure = () => setCols(el.clientWidth >= 640 ? 2 : 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rowCount = Math.ceil(items.length / cols)
  // Window against the page scroll so the grid keeps the document's normal
  // scroll behaviour (the tabs scroll the whole page, not an inner container).
  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: 4,
    scrollMargin: containerRef.current?.offsetTop ?? 0,
  })

  return (
    <div ref={containerRef} className="result-grid result-grid--virtual">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const start = virtualRow.index * cols
          const rowItems = items.slice(start, start + cols)
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="result-grid__row"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              {rowItems.map((item) => (
                <div key={getKey(item)} className="result-grid__cell">
                  {renderItem(item)}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
