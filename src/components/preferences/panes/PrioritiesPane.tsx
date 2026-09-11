import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Loader2,
  Plus,
  Search,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsSection } from '../shared/SettingsComponents'
import { formatDate } from '@/components/senaite/senaite-utils'
import { PriorityGlyph } from '@/components/common/PriorityGlyph'
import { useAuthStore } from '@/store/auth-store'
import {
  getCustomersSeen,
  type CustomerSeen,
  type Priority,
  type PriorityColor,
  type PriorityIcon,
} from '@/lib/api-priorities'
import {
  useAssignPriority,
  useCustomerPriorities,
  usePriorities,
  usePriorityMutations,
} from '@/services/priorities'
import { useSlaTiers } from '@/services/sla'

const ICONS: PriorityIcon[] = [
  'chevrons-up',
  'chevron-up',
  'minus',
  'chevron-down',
  'chevrons-down',
  'flame',
]
const COLORS: PriorityColor[] = [
  'red',
  'amber',
  'emerald',
  'sky',
  'violet',
  'zinc',
]
const NONE = '__none__'
type CustomerSortKey = 'customer' | 'priority' | 'note' | 'updated'

function PaneSpinner() {
  return (
    <div
      data-testid="pane-spinner"
      className="flex items-center justify-center py-8"
    >
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  )
}

export function PrioritiesPane() {
  const { t } = useTranslation()
  // Catalog editing is admin work, but per the Task 5 ruling nothing is gated
  // yet — no control is disabled and no read-only notice is shown, because
  // either would be a false statement in the UI. This read is the single place
  // to flip when gating lands: thread `disabled={!isAdmin}` down from here,
  // the way SlaPane does.
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const listQuery = usePriorities()
  const { data: tiers = [] } = useSlaTiers()
  const m = usePriorityMutations()
  const sorted = [...(listQuery.data ?? [])].sort(
    (a, b) => b.rank - a.rank || a.name.localeCompare(b.name)
  )
  const patch = (
    key: string,
    body: Parameters<typeof m.patch.mutate>[0]['body']
  ) => m.patch.mutate({ key, body })
  // Reordering swaps the two ranks rather than renumbering the list, so one
  // move is two PATCHes and never disturbs the rest of the catalog.
  const swapRank = (i: number, j: number) => {
    const a = sorted[i],
      b = sorted[j]
    if (!a || !b) return
    if (a.rank === b.rank) {
      // Equal ranks sort by name, so swapping them is a no-op the user would
      // read as a broken button. Nudge the moved row one step past its
      // neighbour instead (j < i means it is moving up, i.e. to a higher rank).
      patch(a.key, { rank: j < i ? b.rank + 1 : b.rank - 1 })
      return
    }
    patch(a.key, { rank: b.rank })
    patch(b.key, { rank: a.rank })
  }
  const [newName, setNewName] = useState('')
  const tierName = (id: number | null) =>
    id == null
      ? t('preferences.prioritiesPane.followProfile')
      : (tiers.find(ti => ti.id === id)?.name ?? String(id))

  // The catalog is the whole pane's subject: rendering an Add form beside an
  // empty table would read a failed fetch as "no priorities exist".
  if (listQuery.isLoading) return <PaneSpinner />
  if (listQuery.isError) {
    return (
      <p className="text-sm text-destructive">
        {t('preferences.prioritiesPane.loadError')}
      </p>
    )
  }

  return (
    <div className="space-y-8" data-admin={isAdmin}>
      <SettingsSection title={t('preferences.prioritiesPane.title')}>
        <p className="text-sm text-muted-foreground">
          {t('preferences.prioritiesPane.description')}
        </p>
        <div className="mt-3 divide-y rounded-md border">
          {sorted.map((p, i) => (
            <div
              key={p.key}
              data-testid="priority-row"
              className="grid grid-cols-[28px_1fr_auto] items-center gap-3 px-3 py-2"
            >
              <div className="flex h-7 w-7 items-center justify-center">
                <PriorityGlyph
                  priority={{
                    key: p.key,
                    rank: p.rank,
                    source_level: 'unknown',
                    source_id: null,
                  }}
                  size="card"
                  preview
                />
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    // Keyed on the server-side name: whenever the true name
                    // changes the input remounts on it, so an uncontrolled
                    // defaultValue can never drift from what the row is called.
                    key={`${p.key}:${p.name}`}
                    defaultValue={p.name}
                    aria-label={t('preferences.prioritiesPane.aria.name', {
                      name: p.name,
                    })}
                    className="h-8 w-44"
                    onBlur={e => {
                      const el = e.target
                      const next = el.value.trim()
                      // A blank field is not a rename; put the real name back
                      // rather than leaving the row looking nameless.
                      if (!next) {
                        el.value = p.name
                        return
                      }
                      if (next === p.name) return
                      // A rejected rename leaves the catalog (and therefore the
                      // remount key) unchanged, so the field has to be restored
                      // by hand or it keeps showing a name the server refused.
                      m.patch.mutate(
                        { key: p.key, body: { name: next } },
                        {
                          onError: () => {
                            el.value = p.name
                          },
                        }
                      )
                    }}
                  />
                  <span className="font-mono text-xs text-muted-foreground">
                    rank {p.rank}
                  </span>
                  {/* How much this row is actually in use — the number the
                    deactivation confirm below quotes back. */}
                  <span className="text-xs text-muted-foreground">
                    {t('preferences.prioritiesPane.assignedCount', {
                      count: p.explicit_count,
                    })}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('preferences.prioritiesPane.aria.moveUp', {
                      name: p.name,
                    })}
                    disabled={i === 0}
                    onClick={() => swapRank(i, i - 1)}
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('preferences.prioritiesPane.aria.moveDown', {
                      name: p.name,
                    })}
                    disabled={i === sorted.length - 1}
                    onClick={() => swapRank(i, i + 1)}
                  >
                    <ArrowDown size={14} />
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={p.icon}
                    onValueChange={v =>
                      patch(p.key, { icon: v as PriorityIcon })
                    }
                  >
                    <SelectTrigger
                      className="h-8 w-40"
                      aria-label={t('preferences.prioritiesPane.aria.icon', {
                        name: p.name,
                      })}
                    >
                      {/* Explicit children: a closed Radix Select has no mounted
                        item to portal its label from. */}
                      <SelectValue>{p.icon}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {ICONS.map(ic => (
                        <SelectItem key={ic} value={ic}>
                          {ic}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={p.color}
                    onValueChange={v =>
                      patch(p.key, { color: v as PriorityColor })
                    }
                  >
                    <SelectTrigger
                      className="h-8 w-28"
                      aria-label={t('preferences.prioritiesPane.aria.color', {
                        name: p.name,
                      })}
                    >
                      <SelectValue>{p.color}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {COLORS.map(c => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <label className="flex items-center gap-1 text-xs">
                    <Switch
                      checked={p.pulse}
                      aria-label={t('preferences.prioritiesPane.aria.pulse', {
                        name: p.name,
                      })}
                      onCheckedChange={v => patch(p.key, { pulse: v })}
                    />{' '}
                    {t('preferences.prioritiesPane.pulse')}
                  </label>
                  <Select
                    value={p.sla_tier_id == null ? NONE : String(p.sla_tier_id)}
                    onValueChange={v =>
                      patch(p.key, {
                        sla_tier_id: v === NONE ? null : Number(v),
                      })
                    }
                  >
                    <SelectTrigger
                      className="h-8 w-52"
                      aria-label={t('preferences.prioritiesPane.aria.slaTier', {
                        name: p.name,
                      })}
                    >
                      <SelectValue>{tierName(p.sla_tier_id)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>
                        {t('preferences.prioritiesPane.followProfile')}
                      </SelectItem>
                      {tiers.map(tier => (
                        <SelectItem key={tier.id} value={String(tier.id)}>
                          {tier.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="default-priority"
                    checked={p.is_default}
                    aria-label={t('preferences.prioritiesPane.aria.default', {
                      name: p.name,
                    })}
                    onChange={() => m.setDefault.mutate(p.key)}
                  />{' '}
                  {t('preferences.prioritiesPane.default')}
                </label>
                <label className="flex items-center gap-1">
                  {/* The default priority is the fallback for every sample, so
                      it can never be deactivated. */}
                  <Switch
                    checked={p.is_active}
                    disabled={p.is_default}
                    aria-label={t('preferences.prioritiesPane.aria.active', {
                      name: p.name,
                    })}
                    onCheckedChange={v => {
                      // Turning OFF is the DELETE route, not a PATCH: it is
                      // the one that owns deactivation. Every explicit
                      // assignment silently falls back to Inherit, so the
                      // count is quoted before anything is sent.
                      if (!v) {
                        if (
                          !window.confirm(
                            t('preferences.prioritiesPane.deactivateConfirm', {
                              count: p.explicit_count,
                            })
                          )
                        )
                          return
                        m.deactivate.mutate(p.key)
                        return
                      }
                      patch(p.key, { is_active: true })
                    }}
                  />{' '}
                  {t('preferences.prioritiesPane.active')}
                </label>
              </div>
            </div>
          ))}
        </div>
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={e => {
            e.preventDefault()
            if (!newName.trim()) return
            m.create.mutate({
              name: newName.trim(),
              rank: (sorted[0]?.rank ?? 0) + 10,
              icon: 'chevron-up',
              color: 'amber',
              pulse: false,
            })
            setNewName('')
          }}
        >
          <Input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder={t('preferences.prioritiesPane.newName')}
            className="h-8 w-56"
          />
          <Button type="submit" size="sm" variant="outline">
            <Plus size={14} /> {t('preferences.prioritiesPane.add')}
          </Button>
        </form>
      </SettingsSection>

      <CustomerPrioritiesSection priorities={sorted.filter(p => p.is_active)} />
    </div>
  )
}

function CustomerPrioritiesSection({ priorities }: { priorities: Priority[] }) {
  const { t } = useTranslation()
  const rowsQuery = useCustomerPriorities()
  const rows = rowsQuery.data ?? []
  const assign = useAssignPriority()
  const [sort, setSort] = useState<{
    key: CustomerSortKey
    dir: 'asc' | 'desc'
  }>({
    key: 'updated',
    dir: 'desc',
  })
  const rankOf = (key: string) => priorities.find(p => p.key === key)?.rank ?? 0
  const sortedRows = [...rows].sort((a, b) => {
    const cmp =
      sort.key === 'customer'
        ? (a.customer_name ?? String(a.wp_customer_user_id)).localeCompare(
            b.customer_name ?? String(b.wp_customer_user_id)
          )
        : sort.key === 'priority'
          ? rankOf(a.priority_key) - rankOf(b.priority_key)
          : sort.key === 'note'
            ? (a.note ?? '').localeCompare(b.note ?? '')
            : (a.updated_at ?? '').localeCompare(b.updated_at ?? '')
    return sort.dir === 'asc' ? cmp : -cmp
  })
  const toggleSort = (key: CustomerSortKey) =>
    setSort(s => ({
      key,
      dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc',
    }))
  const [q, setQ] = useState('')
  const [found, setFound] = useState<CustomerSeen[]>([])
  const search = async () => setFound(await getCustomersSeen(q))
  return (
    <SettingsSection title={t('preferences.prioritiesPane.customers')}>
      <p className="text-sm text-muted-foreground">
        {t('preferences.prioritiesPane.customersDescription')}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Input
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
          placeholder={t('preferences.prioritiesPane.searchCustomer')}
          className="h-8 w-72"
        />
        <Button
          size="sm"
          variant="outline"
          aria-label={t('preferences.prioritiesPane.searchCustomer')}
          onClick={search}
        >
          <Search size={14} />
        </Button>
      </div>
      {found.length > 0 && (
        <ul className="mt-2 divide-y rounded-md border text-sm">
          {found.map(c => (
            <li
              key={c.wp_customer_user_id}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <span>
                {c.customer_name ?? '—'}{' '}
                <span className="text-muted-foreground">
                  {c.customer_email}
                </span>
              </span>
              <Select
                onValueChange={v =>
                  assign.mutate({
                    level: 'customer',
                    id: String(c.wp_customer_user_id),
                    priority_key: v,
                  })
                }
              >
                <SelectTrigger
                  className="h-8 w-44"
                  aria-label={t(
                    'preferences.prioritiesPane.aria.setPriorityFor',
                    { email: c.customer_email }
                  )}
                >
                  <SelectValue
                    placeholder={t('preferences.prioritiesPane.setPriority')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {priorities.map(p => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </li>
          ))}
        </ul>
      )}
      {/* Only the assignment table waits on its query — the search above it
          works regardless, so gating the whole section would take away a
          working control. */}
      {rowsQuery.isLoading ? (
        <PaneSpinner />
      ) : rowsQuery.isError ? (
        <p className="mt-4 text-sm text-destructive">
          {t('preferences.prioritiesPane.loadError')}
        </p>
      ) : (
        <table className="mt-4 w-full text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr>
              {(
                [
                  [
                    'customer',
                    t('preferences.prioritiesPane.columns.customer'),
                  ],
                  [
                    'priority',
                    t('preferences.prioritiesPane.columns.priority'),
                  ],
                  ['note', t('preferences.prioritiesPane.columns.note')],
                  ['updated', t('preferences.prioritiesPane.columns.updated')],
                ] as const
              ).map(([key, label]) => (
                <th
                  key={key}
                  className="text-start"
                  aria-sort={
                    sort.key === key
                      ? sort.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 uppercase hover:text-foreground"
                    onClick={() => toggleSort(key)}
                  >
                    {label}
                    {sort.key === key ? (
                      sort.dir === 'asc' ? (
                        <ArrowUp size={12} />
                      ) : (
                        <ArrowDown size={12} />
                      )
                    ) : (
                      <ArrowUpDown size={12} className="opacity-40" />
                    )}
                  </button>
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(r => (
              <tr key={r.wp_customer_user_id} className="border-t">
                <td className="py-1">
                  {r.customer_name ?? r.wp_customer_user_id}{' '}
                  <span className="text-muted-foreground">
                    {r.customer_email}
                  </span>
                </td>
                <td>
                  {priorities.find(p => p.key === r.priority_key)?.name ??
                    r.priority_key}
                </td>
                <td className="text-muted-foreground">{r.note}</td>
                <td className="text-muted-foreground">
                  {r.updated_by_name ?? '—'} · {formatDate(r.updated_at)}
                </td>
                <td className="text-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      assign.mutate({
                        level: 'customer',
                        id: String(r.wp_customer_user_id),
                        priority_key: null,
                      })
                    }
                  >
                    {t('preferences.prioritiesPane.clear')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SettingsSection>
  )
}
