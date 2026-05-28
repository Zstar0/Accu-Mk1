import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { SettingsSection } from '../shared/SettingsComponents'
import { useAuthStore } from '@/store/auth-store'
import {
  useSlaTiers, useSlaPriorityTiers, useCreateSlaTier, useUpdateSlaTier,
  useDeleteSlaTier, useSetPriorityTier, useDeletePriorityTier,
} from '@/services/sla'
import { useServiceGroups } from '@/services/service-groups'
import type { InboxPriority, ServiceGroup, SlaTier } from '@/lib/api'

const OVERRIDABLE: ('high' | 'expedited')[] = ['high', 'expedited']

function minutesToHM(m: number) {
  return { hours: Math.floor(m / 60), minutes: m % 60 }
}

export function SlaPane() {
  const { t } = useTranslation()
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const tiersQuery = useSlaTiers()
  const prioQuery = useSlaPriorityTiers()
  const groupsQuery = useServiceGroups()
  const createTier = useCreateSlaTier()
  const updateTier = useUpdateSlaTier()
  const deleteTier = useDeleteSlaTier()
  const setPrio = useSetPriorityTier()
  const delPrio = useDeletePriorityTier()

  const tiers = tiersQuery.data ?? []
  const groups = groupsQuery.data ?? []
  const sorted = [...tiers].sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name))
  // Multi-tier reshape: build a per-(priority, group_id-or-NULL) lookup so the
  // UI can render one row per global+group override the lab has configured.
  // Key composition: `${priority}|${group_id ?? 'global'}` — matches the
  // backend partial-unique-index split between NULL-group (global) and
  // non-NULL-group rows.
  const overrideKey = (priority: InboxPriority, groupId: number | null) =>
    `${priority}|${groupId ?? 'global'}`
  const overrideTierByKey = new Map(
    (prioQuery.data ?? []).map(p => [overrideKey(p.priority, p.service_group_id), p.sla_tier_id])
  )
  const groupsWithOverrideByPriority = new Map<InboxPriority, Set<number>>()
  for (const row of prioQuery.data ?? []) {
    if (row.service_group_id == null) continue
    const set = groupsWithOverrideByPriority.get(row.priority) ?? new Set<number>()
    set.add(row.service_group_id)
    groupsWithOverrideByPriority.set(row.priority, set)
  }

  if (tiersQuery.isLoading || prioQuery.isLoading || groupsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (tiersQuery.isError) {
    return <p className="text-sm text-destructive">{t('preferences.sla.loadError')}</p>
  }

  return (
    <div className="space-y-8">
      {!isAdmin && (
        <p className="text-sm text-muted-foreground">{t('preferences.sla.readOnly')}</p>
      )}

      <SettingsSection title={t('preferences.sla.tiers')}>
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{t('preferences.sla.tiersDescription')}</p>
          {isAdmin && (
            <Button size="sm" onClick={() => createTier.mutate({ name: t('preferences.sla.newTierDefaultName'), target_minutes: 1440 })}>
              <Plus className="mr-1 h-4 w-4" /> {t('preferences.sla.addTier')}
            </Button>
          )}
        </div>
        <div className="space-y-3">
          {sorted.map(tier => (
            <TierCard
              key={`${tier.id}-${tier.updated_at}`}
              tier={tier}
              readOnly={!isAdmin}
              onSave={(data) => updateTier.mutate({ id: tier.id, data })}
              onDelete={() => deleteTier.mutate(tier.id)}
            />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t('preferences.sla.priorityOverrides')}>
        <p className="text-sm text-muted-foreground">{t('preferences.sla.priorityOverridesDescription')}</p>
        <div className="space-y-6">
          {OVERRIDABLE.map(priority => (
            <PriorityOverrideGroup
              key={priority}
              priority={priority}
              tiers={tiers}
              groups={groups}
              globalTierId={overrideTierByKey.get(overrideKey(priority, null))}
              perGroupRows={(prioQuery.data ?? []).filter(p => p.priority === priority && p.service_group_id != null)}
              alreadyOverriddenGroupIds={groupsWithOverrideByPriority.get(priority) ?? new Set()}
              readOnly={!isAdmin}
              onSetTier={(tierId, groupId) => setPrio.mutate({ priority, slaTierId: tierId, serviceGroupId: groupId })}
              onDelete={(groupId) => delPrio.mutate({ priority, serviceGroupId: groupId })}
            />
          ))}
        </div>
      </SettingsSection>
    </div>
  )
}

/**
 * Per-priority overrides block. Renders:
 *   - One "All groups" row (the legacy global override, NULL group_id).
 *   - One row per existing per-(priority, group) override, each with a delete button.
 *   - "+ Add group-specific override" — opens a pending row with a group picker
 *     and tier picker; saves on confirm. Only available when at least one
 *     group is still un-overridden for this priority.
 */
function PriorityOverrideGroup({
  priority, tiers, groups, globalTierId, perGroupRows,
  alreadyOverriddenGroupIds, readOnly,
  onSetTier, onDelete,
}: {
  priority: 'high' | 'expedited'
  tiers: SlaTier[]
  groups: ServiceGroup[]
  globalTierId: number | undefined
  perGroupRows: { id: number; service_group_id: number | null; sla_tier_id: number }[]
  alreadyOverriddenGroupIds: Set<number>
  readOnly: boolean
  // Callers wire these to setPrio / delPrio mutations with the right priority.
  // groupId=null targets the global row; an integer targets that group's row.
  onSetTier: (tierId: number, groupId: number | null) => void
  onDelete: (groupId: number | null) => void
}) {
  const { t } = useTranslation()
  // The pending row is the "+ Add" UI before the user has clicked Save —
  // tracks the not-yet-persisted group selection. Null = no pending row;
  // 'unpicked' = row shown but group not selected yet.
  const [pendingGroupId, setPendingGroupId] = useState<number | null | 'unpicked'>(null)
  const [pendingTierId, setPendingTierId] = useState<number | null>(null)
  const availableGroups = groups.filter(g => !alreadyOverriddenGroupIds.has(g.id) && (pendingGroupId === g.id || pendingGroupId === 'unpicked'))

  const closePending = () => {
    setPendingGroupId(null)
    setPendingTierId(null)
  }

  const handleConfirmPending = () => {
    if (pendingGroupId == null || pendingGroupId === 'unpicked' || pendingTierId == null) return
    onSetTier(pendingTierId, pendingGroupId)
    closePending()
  }

  return (
    <div data-testid={`sla-priority-block-${priority}`} className="space-y-2 rounded-md border bg-card/30 px-3 py-2">
      <span className="text-sm font-medium capitalize">{priority}</span>
      <div className="space-y-1.5">
        {/* Global ("All groups") row — NULL service_group_id */}
        <div className="flex items-center gap-3">
          <span className="w-36 text-xs text-muted-foreground">
            {t('preferences.sla.globalOverride')}
          </span>
          <Select
            disabled={readOnly}
            value={globalTierId == null ? 'none' : String(globalTierId)}
            onValueChange={(v) =>
              v === 'none' ? onDelete(null) : onSetTier(Number(v), null)
            }
          >
            <SelectTrigger data-testid={`sla-priority-global-tier-${priority}`} className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('preferences.sla.noOverride')}</SelectItem>
              {tiers.map(ti => (
                <SelectItem key={ti.id} value={String(ti.id)}>{ti.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* One row per existing per-(priority, group) override */}
        {perGroupRows.map(row => {
          const group = groups.find(g => g.id === row.service_group_id)
          if (!group || row.service_group_id == null) return null
          const groupId: number = row.service_group_id
          return (
            <div key={row.id} data-testid={`sla-priority-group-row-${priority}-${groupId}`} className="flex items-center gap-3">
              <span className="w-36 text-xs">{group.name}</span>
              <Select
                disabled={readOnly}
                value={String(row.sla_tier_id)}
                onValueChange={(v) => onSetTier(Number(v), groupId)}
              >
                <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {tiers.map(ti => (
                    <SelectItem key={ti.id} value={String(ti.id)}>{ti.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!readOnly && (
                <Button
                  variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                  aria-label={t('preferences.sla.removeOverride')}
                  onClick={() => onDelete(groupId)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )
        })}
        {/* Pending row (after user clicks "+ Add"). Hidden until "+ Add" pressed. */}
        {pendingGroupId !== null && (
          <div data-testid={`sla-priority-pending-row-${priority}`} className="flex items-center gap-3">
            <Select
              value={pendingGroupId === 'unpicked' ? 'unpicked' : String(pendingGroupId)}
              onValueChange={(v) => setPendingGroupId(v === 'unpicked' ? 'unpicked' : Number(v))}
            >
              <SelectTrigger className="w-36 h-9 text-xs"><SelectValue placeholder={t('preferences.sla.selectGroup')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unpicked" disabled>{t('preferences.sla.selectGroup')}</SelectItem>
                {availableGroups.map(g => (
                  <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={pendingTierId == null ? 'none' : String(pendingTierId)}
              onValueChange={(v) => setPendingTierId(v === 'none' ? null : Number(v))}
            >
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none" disabled>{t('preferences.sla.noOverride')}</SelectItem>
                {tiers.map(ti => (
                  <SelectItem key={ti.id} value={String(ti.id)}>{ti.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm" disabled={pendingGroupId === 'unpicked' || pendingTierId == null}
              onClick={handleConfirmPending}
            >
              {t('actions.add', { defaultValue: 'Add' })}
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="cancel" onClick={closePending}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        {!readOnly && pendingGroupId === null && groups.length > alreadyOverriddenGroupIds.size && (
          <Button
            variant="ghost" size="sm"
            data-testid={`sla-priority-add-group-${priority}`}
            onClick={() => setPendingGroupId('unpicked')}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('preferences.sla.addGroupOverride')}
          </Button>
        )}
      </div>
    </div>
  )
}

/** Parse and clamp amber threshold to [1, 100]. Falls back to the current tier
 *  value on invalid/out-of-range input — keeps invariants tight. */
function clampAmber(raw: string, fallback: number): number {
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 100 ? parsed : fallback
}

function TierCard({
  tier, readOnly, onSave, onDelete,
}: {
  tier: SlaTier
  readOnly: boolean
  onSave: (data: {
    name: string
    target_minutes: number
    business_hours_only: boolean
    amber_threshold_percent: number
  }) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const hm = minutesToHM(tier.target_minutes)
  const [name, setName] = useState(tier.name)
  const [hours, setHours] = useState(String(hm.hours))
  const [minutes, setMinutes] = useState(String(hm.minutes))
  const [bh, setBh] = useState(tier.business_hours_only)
  const [amber, setAmber] = useState(String(tier.amber_threshold_percent))

  const buildPayload = (overrides?: Partial<{
    name: string
    target_minutes: number
    business_hours_only: boolean
    amber_threshold_percent: number
  }>) => ({
    name: name.trim() || tier.name,
    target_minutes: (parseInt(hours, 10) || 0) * 60 + (parseInt(minutes, 10) || 0),
    business_hours_only: bh,
    amber_threshold_percent: clampAmber(amber, tier.amber_threshold_percent),
    ...overrides,
  })

  const commit = () => {
    if (readOnly) return
    const next = buildPayload()
    // Snap input back to the persisted (clamped) value so it doesn't display garbage.
    if (next.amber_threshold_percent !== parseInt(amber, 10)) {
      setAmber(String(next.amber_threshold_percent))
    }
    if (
      next.name === tier.name &&
      next.target_minutes === tier.target_minutes &&
      next.business_hours_only === tier.business_hours_only &&
      next.amber_threshold_percent === tier.amber_threshold_percent
    ) {
      return // nothing changed
    }
    onSave(next)
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Input
            className="h-8 w-48 font-medium" value={name} disabled={readOnly}
            onChange={e => setName(e.target.value)} onBlur={commit}
          />
          {tier.is_default && <Badge variant="outline" className="text-[10px]">{t('preferences.sla.default')}</Badge>}
        </div>
        {!readOnly && !tier.is_default && (
          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('preferences.sla.target')}:</span>
        <Input className="h-8 w-16" type="number" min={0} value={hours} disabled={readOnly}
          onChange={e => setHours(e.target.value)} onBlur={commit} />
        <span className="text-muted-foreground">{t('preferences.sla.hours')}</span>
        <Input className="h-8 w-16" type="number" min={0} max={59} value={minutes} disabled={readOnly}
          onChange={e => setMinutes(e.target.value)} onBlur={commit} />
        <span className="text-muted-foreground">{t('preferences.sla.minutes')}</span>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={bh}
          disabled={readOnly}
          onCheckedChange={(v: boolean) => {
            setBh(v)
            if (!readOnly) {
              onSave(buildPayload({ business_hours_only: v }))
            }
          }}
        />
        <span className="text-sm">{t('preferences.sla.businessHoursOnly')}</span>
        <span className="text-xs text-muted-foreground">— {t('preferences.sla.businessHoursHint')}</span>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('preferences.sla.amberThreshold')}</span>
        <Input
          data-testid={`sla-amber-input-${tier.id}`}
          className="h-8 w-16"
          type="number"
          min={1}
          max={100}
          value={amber}
          disabled={readOnly}
          onChange={e => setAmber(e.target.value)}
          onBlur={commit}
        />
        <span className="text-muted-foreground">{t('preferences.sla.percentRemaining')}</span>
      </div>
    </div>
  )
}
