import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Plus, Search } from 'lucide-react'
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

export function PrioritiesPane() {
  const { t } = useTranslation()
  // Catalog editing is admin work, but per the Task 5 ruling nothing is gated
  // yet — no control is disabled and no read-only notice is shown, because
  // either would be a false statement in the UI. This read is the single place
  // to flip when gating lands: thread `disabled={!isAdmin}` down from here,
  // the way SlaPane does.
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const { data: list = [] } = usePriorities()
  const { data: tiers = [] } = useSlaTiers()
  const m = usePriorityMutations()
  const sorted = [...list].sort(
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
    patch(a.key, { rank: b.rank })
    patch(b.key, { rank: a.rank })
  }
  const [newName, setNewName] = useState('')
  const tierName = (id: number | null) =>
    id == null
      ? t('preferences.prioritiesPane.followProfile')
      : (tiers.find(ti => ti.id === id)?.name ?? String(id))

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
              <PriorityGlyph
                priority={{
                  key: p.key,
                  rank: p.rank,
                  source_level: 'sample',
                  source_id: null,
                }}
                size="card"
              />
              <div className="flex flex-wrap items-center gap-2">
                {/* Row identity: the name as it reads today. The input beside
                    it renames on blur — the glyph is null for the default
                    priority, so this is the row's only stable label. */}
                <span className="w-28 truncate text-sm font-medium">
                  {p.name}
                </span>
                <Input
                  defaultValue={p.name}
                  aria-label={`Name ${p.name}`}
                  className="h-8 w-44"
                  onBlur={e =>
                    e.target.value !== p.name &&
                    patch(p.key, { name: e.target.value })
                  }
                />
                <span className="font-mono text-xs text-muted-foreground">
                  rank {p.rank}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move up ${p.name}`}
                  disabled={i === 0}
                  onClick={() => swapRank(i, i - 1)}
                >
                  <ArrowUp size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move down ${p.name}`}
                  disabled={i === sorted.length - 1}
                  onClick={() => swapRank(i, i + 1)}
                >
                  <ArrowDown size={14} />
                </Button>
                <Select
                  value={p.icon}
                  onValueChange={v => patch(p.key, { icon: v as PriorityIcon })}
                >
                  <SelectTrigger
                    className="h-8 w-40"
                    aria-label={`Icon ${p.name}`}
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
                    aria-label={`Color ${p.name}`}
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
                    aria-label={`Pulse ${p.name}`}
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
                    aria-label={`SLA tier ${p.name}`}
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
              <div className="flex items-center gap-3 text-xs">
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="default-priority"
                    checked={p.is_default}
                    aria-label={`Default ${p.name}`}
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
                    aria-label={`Active ${p.name}`}
                    onCheckedChange={v => patch(p.key, { is_active: v })}
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
  const { data: rows = [] } = useCustomerPriorities()
  const assign = useAssignPriority()
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
                  aria-label={`Set priority for ${c.customer_email}`}
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
      <table className="mt-4 w-full text-sm">
        <thead className="text-xs uppercase text-muted-foreground">
          <tr>
            <th className="text-start">Customer</th>
            <th className="text-start">Priority</th>
            <th className="text-start">Note</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
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
    </SettingsSection>
  )
}
