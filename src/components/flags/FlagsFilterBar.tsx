import { Search } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { FlagStatus } from '@/lib/flags-api'
import {
  STATUS_LABELS,
  STATUS_DOT,
  STATUS_ORDER,
  OPEN_STATUSES,
} from '@/components/flags/flag-status'
import { entityMeta } from '@/components/flags/flag-entity'
import { useFlagTypes } from '@/services/flag-types'
import { useItemKinds } from '@/services/item-kinds'
import { useFlagUsers } from '@/components/flags/flag-users'
import { displayName } from '@/lib/user-display'
import type { FlagFilterState } from '@/components/flags/flag-filter'

/** Entity types offered in the filter, in display order. Labels resolve via
 *  ENTITY_META so they stay in sync with the chips (sub_sample → "Vial"). */
const ENTITY_TYPES = ['sample', 'sub_sample', 'worksheet']

/** A small colored dot, used for status options. */
function Dot({ color }: { color: string }) {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  )
}

/**
 * Compact, sticky triage filter row for the flyout: free-text search (title or
 * Sample ID) + Status, Type, and Entity selects. Controlled — the flyout owns
 * the ephemeral state and applies {@link filterFlags} to the fetched list.
 */
export function FlagsFilterBar({
  value,
  onChange,
  showAssignee = true,
}: {
  value: FlagFilterState
  onChange: (next: FlagFilterState) => void
  /** Hidden on the Assigned-to-me tab (every flag there is already mine). */
  showAssignee?: boolean
}) {
  // Managed type catalog (incl. inactive, so a deactivated type with open flags
  // is still filterable), ordered by sort_order.
  const { data: typeRows } = useFlagTypes({})
  const types = [...(typeRows ?? [])].sort(
    (a, b) => a.sort_order - b.sort_order
  )
  // Active virtual item kinds, filterable by slug. general_task is excluded —
  // it rides the 'general' sentinel option (which also matches legacy null
  // anchors) rather than getting a redundant second entry.
  const { data: kindRows } = useItemKinds({ active_only: true })
  const kinds = [...(kindRows ?? [])]
    .filter(k => k.slug !== 'general_task')
    .sort((a, b) => a.sort_order - b.sort_order)
  // Shared user directory (same query mention-autocomplete loads), sorted by
  // display name for the assignee dropdown.
  const userMap = useFlagUsers()
  const users = [...userMap.values()].sort((a, b) =>
    displayName(a).localeCompare(displayName(b))
  )

  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={value.text}
          onChange={e => onChange({ ...value, text: e.target.value })}
          placeholder="Search title, Sample ID, or comments…"
          aria-label="Search flags by title, Sample ID, or comment"
          className="h-8 ps-8 text-xs"
        />
      </div>

      <Select
        value={value.status}
        onValueChange={status => onChange({ ...value, status })}
      >
        <SelectTrigger
          size="sm"
          aria-label="Filter by status"
          className="h-8 w-auto text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          <SelectItem value="all_open">
            <span className="flex -space-x-0.5">
              {OPEN_STATUSES.map(s => (
                <Dot key={s} color={STATUS_DOT[s]} />
              ))}
            </span>
            All open
          </SelectItem>
          {STATUS_ORDER.map(s => (
            <SelectItem key={s} value={s}>
              <Dot color={STATUS_DOT[s]} />
              {STATUS_LABELS[s as FlagStatus]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={value.type}
        onValueChange={type => onChange({ ...value, type })}
      >
        <SelectTrigger
          size="sm"
          aria-label="Filter by type"
          className="h-8 w-auto text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All types</SelectItem>
          {types.map(t => (
            <SelectItem key={t.slug} value={t.slug}>
              <Dot color={t.color} />
              {t.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={value.entityType}
        onValueChange={entityType => onChange({ ...value, entityType })}
      >
        <SelectTrigger
          size="sm"
          aria-label="Filter by item"
          className="h-8 w-auto text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All items</SelectItem>
          {ENTITY_TYPES.map(t => (
            <SelectItem key={t} value={t}>
              {entityMeta(t).label}
            </SelectItem>
          ))}
          <SelectItem value="general">General Task</SelectItem>
          {kinds.map(k => (
            <SelectItem key={k.slug} value={k.slug}>
              {k.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showAssignee && (
        <Select
          value={value.assignee}
          onValueChange={assignee => onChange({ ...value, assignee })}
        >
          <SelectTrigger
            size="sm"
            aria-label="Filter by assignee"
            className="h-8 w-auto text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Anyone</SelectItem>
            <SelectItem value="none">Unassigned</SelectItem>
            {users.map(u => (
              <SelectItem key={u.id} value={String(u.id)}>
                {displayName(u)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Button
        type="button"
        variant={value.overdueOnly ? 'default' : 'ghost'}
        size="sm"
        aria-pressed={value.overdueOnly}
        className="h-8 px-2 text-xs"
        onClick={() => onChange({ ...value, overdueOnly: !value.overdueOnly })}
      >
        Overdue
      </Button>
    </div>
  )
}

export default FlagsFilterBar
