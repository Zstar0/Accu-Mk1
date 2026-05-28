import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Loader2 } from 'lucide-react'
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
import type { SlaTier } from '@/lib/api'

const OVERRIDABLE: ('high' | 'expedited')[] = ['high', 'expedited']

function minutesToHM(m: number) {
  return { hours: Math.floor(m / 60), minutes: m % 60 }
}

export function SlaPane() {
  const { t } = useTranslation()
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const tiersQuery = useSlaTiers()
  const prioQuery = useSlaPriorityTiers()
  const createTier = useCreateSlaTier()
  const updateTier = useUpdateSlaTier()
  const deleteTier = useDeleteSlaTier()
  const setPrio = useSetPriorityTier()
  const delPrio = useDeletePriorityTier()

  const tiers = tiersQuery.data ?? []
  const sorted = [...tiers].sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name))
  const prioMap = new Map((prioQuery.data ?? []).map(p => [p.priority, p.sla_tier_id]))

  if (tiersQuery.isLoading || prioQuery.isLoading) {
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
        <div className="space-y-2">
          {OVERRIDABLE.map(priority => (
            <div key={priority} className="flex items-center gap-3">
              <span className="w-24 text-sm capitalize">{priority}</span>
              <Select
                disabled={!isAdmin}
                value={prioMap.has(priority) ? String(prioMap.get(priority)) : 'none'}
                onValueChange={(v) =>
                  v === 'none' ? delPrio.mutate(priority) : setPrio.mutate({ priority, slaTierId: Number(v) })
                }
              >
                <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('preferences.sla.noOverride')}</SelectItem>
                  {tiers.map(ti => (
                    <SelectItem key={ti.id} value={String(ti.id)}>{ti.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </SettingsSection>
    </div>
  )
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

  const commit = () => {
    if (readOnly) return
    const total = (parseInt(hours, 10) || 0) * 60 + (parseInt(minutes, 10) || 0)
    const nextName = name.trim() || tier.name
    const amberParsed = parseInt(amber, 10)
    const nextAmber =
      Number.isFinite(amberParsed) && amberParsed >= 1 && amberParsed <= 100
        ? amberParsed
        : tier.amber_threshold_percent
    if (
      nextName === tier.name &&
      total === tier.target_minutes &&
      bh === tier.business_hours_only &&
      nextAmber === tier.amber_threshold_percent
    ) {
      return // nothing changed
    }
    onSave({
      name: nextName,
      target_minutes: total,
      business_hours_only: bh,
      amber_threshold_percent: nextAmber,
    })
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
              onSave({
                name: name.trim() || tier.name,
                target_minutes: (parseInt(hours, 10) || 0) * 60 + (parseInt(minutes, 10) || 0),
                business_hours_only: v,
                amber_threshold_percent: Math.min(
                  100,
                  Math.max(1, parseInt(amber, 10) || tier.amber_threshold_percent)
                ),
              })
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
