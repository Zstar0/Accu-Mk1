/**
 * Search-as-you-type pickers for the flag thread's related-links row. Both
 * mirror the composer's @mention-picker idiom: an absolute dropdown listbox and
 * onMouseDown+preventDefault selection (onClick would blur the input first and
 * drop the pick). Password managers overlay lone text inputs, so every field
 * opts out of autofill (autoComplete off + data-1p-ignore / data-lpignore).
 */
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { flagKeys, useEntitySearch, useFlagSearch } from '@/hooks/use-flags'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { addEntityLink, addFlagLink } from '@/lib/flags-api'
import type { FlagStatus } from '@/lib/flags-api'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import { STATUS_DOT } from '@/components/flags/flag-status'
import { cn } from '@/lib/utils'

/** ↑/↓ move the highlight, Enter picks the active row. Shared by both pickers. */
function onNavKey(
  e: React.KeyboardEvent,
  count: number,
  active: number,
  setActive: (updater: (i: number) => number) => void,
  pick: (i: number) => void
) {
  if (count === 0) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    setActive(i => Math.min(i + 1, count - 1))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    setActive(i => Math.max(i - 1, 0))
  } else if (e.key === 'Enter') {
    e.preventDefault()
    pick(active)
  }
}

function Dropdown({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="listbox"
      className="absolute left-0 top-full z-20 mt-1 max-h-56 w-64 overflow-auto rounded-md border bg-popover shadow-md"
    >
      {children}
    </div>
  )
}

function Row({
  active,
  onPick,
  children,
}: {
  active: boolean
  onPick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseDown={e => {
        e.preventDefault()
        onPick()
      }}
      className={cn(
        'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs',
        active ? 'bg-accent' : 'hover:bg-accent/60'
      )}
    >
      {children}
    </button>
  )
}

const ENTITY_TYPES: { value: string; label: string }[] = [
  { value: 'sub_sample', label: 'Sub Sample' },
  { value: 'sample', label: 'Sample' },
  { value: 'worksheet', label: 'Worksheet' },
]

/** Typeahead that links a related entity (sample / vial / worksheet). The
 *  entity-type Select scopes the search; picking a hit calls addEntityLink. */
export function EntityLinkPicker({ flagId }: { flagId: number }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [etype, setEtype] = useState('sub_sample')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const debounced = useDebouncedValue(query.trim(), 300)
  const { data } = useEntitySearch(etype, debounced)
  const results = data ?? []

  const add = useMutation({
    mutationFn: (entityId: string) => addEntityLink(flagId, etype, entityId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: flagKeys.all })
      setQuery('')
      setActive(0)
      setOpen(false)
    },
  })

  const pick = (i: number) => {
    const hit = results[i]
    if (hit) add.mutate(hit.entity_id)
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-3 w-3" /> item
      </Button>
    )
  }

  return (
    <span className="relative inline-flex items-center gap-1">
      <Select
        value={etype}
        onValueChange={v => {
          setEtype(v)
          setActive(0)
        }}
      >
        <SelectTrigger size="sm" className="h-6 w-24 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ENTITY_TYPES.map(t => (
            <SelectItem key={t.value} value={t.value}>
              {t.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        autoFocus
        value={query}
        placeholder="search…"
        aria-label="Search related item"
        onChange={e => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            setOpen(false)
            return
          }
          onNavKey(e, results.length, active, setActive, pick)
        }}
        className="h-6 w-32 text-xs"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
      />
      {debounced.length >= 2 && results.length > 0 && (
        <Dropdown>
          {results.map((r, i) => (
            <Row key={r.entity_id} active={i === active} onPick={() => pick(i)}>
              <span className="truncate">{r.label}</span>
            </Row>
          ))}
        </Dropdown>
      )}
    </span>
  )
}

/** Typeahead that links another flag as related. Renders each hit as a status
 *  dot + `#id title` + type pill; excludes the current flag (no self-link).
 *  Picking a hit calls addFlagLink. */
export function FlagLinkPicker({ flagId }: { flagId: number }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const debounced = useDebouncedValue(query.trim(), 300)
  const { data } = useFlagSearch(debounced)
  const results = (data ?? []).filter(h => h.flag_id !== flagId)

  const add = useMutation({
    mutationFn: (otherId: number) => addFlagLink(flagId, otherId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: flagKeys.all })
      setQuery('')
      setActive(0)
      setOpen(false)
    },
  })

  const pick = (i: number) => {
    const hit = results[i]
    if (hit) add.mutate(hit.flag_id)
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-3 w-3" /> flag
      </Button>
    )
  }

  return (
    <span className="relative inline-flex items-center gap-1">
      <Input
        autoFocus
        value={query}
        placeholder="search flags…"
        aria-label="Search related flag"
        onChange={e => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            setOpen(false)
            return
          }
          onNavKey(e, results.length, active, setActive, pick)
        }}
        className="h-6 w-40 text-xs"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
      />
      {debounced.length >= 3 && results.length > 0 && (
        <Dropdown>
          {results.map((h, i) => {
            const def = flagTypeDef(h.type)
            return (
              <Row key={h.flag_id} active={i === active} onPick={() => pick(i)}>
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      STATUS_DOT[h.status as FlagStatus] ?? '#94a3b8',
                  }}
                />
                <span className="truncate">
                  #{h.flag_id} {h.title}
                </span>
                <span
                  className="ml-auto shrink-0 rounded px-1 py-0.5 text-[10px] font-medium text-white"
                  style={{ backgroundColor: def.color }}
                >
                  {def.label}
                </span>
              </Row>
            )
          })}
        </Dropdown>
      )}
    </span>
  )
}
