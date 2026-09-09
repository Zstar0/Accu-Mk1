import { useId, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import type { ThroughputClientFacet } from '@/lib/api'

/**
 * Type-to-filter customer picker for the Lab Throughput filter bar.
 *
 * The facet list is a few hundred names on production, which is more than a
 * native `<select>` can be walked through, so the box filters as you type. It
 * is deliberately a plain input + listbox rather than the shadcn Popover +
 * Command recipe: nothing else in this repo composes those two, and the report
 * only needs a single-select over a list it already has in memory.
 *
 * Typing is *not* a filter change — only picking an option calls `onChange`, so
 * keystrokes never refetch the report. While the list is open the box shows the
 * query; closing it without a pick restores the committed customer.
 */

const MAX_ROWS = 100

interface Row {
  value: string
  label: string
  count: number | null
}

export function CustomerCombobox({
  value,
  options,
  onChange,
  className,
}: {
  /** The committed customer name; `''` means every customer. */
  value: string
  options: ThroughputClientFacet[]
  onChange: (value: string) => void
  className?: string
}) {
  const id = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // `null` = not typing, so the box shows the committed value and the list is
  // unfiltered. Any keystroke makes this a string.
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState<number | null>(null)

  const text = query ?? value
  const needle = (query ?? '').trim().toLowerCase()
  const matches = needle
    ? options.filter(o => o.name.toLowerCase().includes(needle))
    : options
  const hidden = Math.max(0, matches.length - MAX_ROWS)
  const empty = needle.length > 0 && matches.length === 0

  const rows: Row[] = empty
    ? []
    : [
        { value: '', label: 'All customers', count: null },
        ...matches
          .slice(0, MAX_ROWS)
          .map(o => ({ value: o.name, label: o.name, count: o.samples })),
      ]

  // With a query typed, Enter should take the best match rather than "All
  // customers"; with an empty box the top row is the sensible landing spot.
  const fallback = needle && rows.length > 1 ? 1 : 0
  const current = Math.min(active ?? fallback, Math.max(0, rows.length - 1))

  function close() {
    setOpen(false)
    setQuery(null)
    setActive(null)
  }

  function commit(next: string) {
    onChange(next)
    close()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Tab') {
      close()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      if (!rows.length) return
      const next = e.key === 'ArrowDown' ? current + 1 : current - 1
      setActive(Math.max(0, Math.min(rows.length - 1, next)))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[current]
      if (open && row) commit(row.value)
    }
  }

  return (
    <div
      ref={containerRef}
      className={cn('relative', className)}
      onBlur={e => {
        if (!containerRef.current?.contains(e.relatedTarget as Node | null)) {
          close()
        }
      }}
    >
      <Input
        type="text"
        role="combobox"
        aria-label="Customer"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={
          open && rows[current] ? `${id}-opt-${current}` : undefined
        }
        autoComplete="off"
        placeholder="All customers"
        value={text}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={e => {
          setQuery(e.target.value)
          setActive(null)
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
        className="h-8 w-56 text-sm"
      />
      {open && (
        <div className="absolute left-0 top-9 z-20 max-h-64 w-72 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          <ul id={`${id}-list`} role="listbox" aria-label="Customer">
            {rows.map((row, i) => (
              <li
                key={row.value || '__all__'}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === current}
                // Keep focus on the input so the click lands before the blur.
                onMouseDown={e => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(row.value)}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1 text-sm',
                  i === current && 'bg-accent text-accent-foreground',
                  !row.value && 'text-muted-foreground'
                )}
              >
                <span className="truncate" title={row.label}>
                  {row.label}
                </span>
                {row.count !== null && (
                  <span className="shrink-0 tabular-nums text-xs opacity-60">
                    {row.count}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {empty && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              No matching customer
            </p>
          )}
          {hidden > 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {hidden} more — keep typing
            </p>
          )}
        </div>
      )}
    </div>
  )
}
