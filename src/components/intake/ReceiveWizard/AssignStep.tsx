import { useEffect, useState, useCallback } from 'react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragEndEvent,
} from '@dnd-kit/core'
import { HelpCircle, Loader2, MessageSquare, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import {
  getVialPlan,
  patchVialAssignment,
  putVarianceOverride,
  updateSenaiteSampleFields,
  type VialPlanResponse,
  type VialPlanItem,
  type AssignmentRole,
} from '@/lib/api'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { invalidateVialAssignmentCaches } from '@/lib/vial-assignment'

interface Props {
  parentSampleId: string
  /** SENAITE UID of the parent — required for saving remarks to the AR.
   *  Optional so the component still renders if the lookup is in flight. */
  parentSampleUid?: string | null
}

const ROLE_SHORT: Record<string, string> = {
  hplc: 'HPLC',
  endo: 'ENDO',
  ster: 'STERYL',
  xtra: 'XTRA',
}

type BucketId = AssignmentRole

export function AssignStep({ parentSampleId, parentSampleUid }: Props) {
  const [plan, setPlan] = useState<VialPlanResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getVialPlan(parentSampleId)
      setPlan(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [parentSampleId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (!plan) return
      const sampleId = String(event.active.id)
      const target = event.over?.id ? (String(event.over.id) as BucketId) : null
      if (!target) return
      // Optimistic update
      const next = {
        ...plan,
        vials: plan.vials.map(v =>
          v.sample_id === sampleId ? { ...v, assignment_role: target } : v
        ),
      }
      setPlan(next)
      try {
        await patchVialAssignment(sampleId, target)
        // PATCH re-seeds/drops the vial's analyses server-side; refresh the
        // parent sample page's assignment caches so its AR overlay isn't stale.
        invalidateVialAssignmentCaches(queryClient, parentSampleId)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        // Roll back by re-fetching
        void refresh()
      }
    },
    [plan, refresh, queryClient, parentSampleId],
  )

  const handleResetBucket = useCallback(
    async (bucket: BucketId) => {
      if (!plan) return
      const inBucket = plan.vials.filter(
        v => v.assignment_role === bucket && !v.is_parent
      )
      // Null each (PATCH null) — IS-side default coerces parent if it's caught here
      try {
        await Promise.all(
          inBucket.map(v => patchVialAssignment(v.sample_id, null))
        )
        invalidateVialAssignmentCaches(queryClient, parentSampleId)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        void refresh()
      }
    },
    [plan, refresh, queryClient, parentSampleId],
  )

  if (loading && !plan) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (error && !plan) {
    return <div className="p-6 text-destructive text-sm">Error: {error}</div>
  }
  if (!plan) return null

  // Build the bucket list. Microbiology section hidden if neither addon present.
  const showMicro = (plan.demand.endo + plan.demand.ster) > 0 ||
    plan.vials.some(v => v.assignment_role === 'endo' || v.assignment_role === 'ster')
  const showHplc = plan.demand.hplc > 0 ||
    plan.vials.some(v => v.assignment_role === 'hplc')
  // Xtra is always rendered: it doubles as the drop target for manually
  // surplussing a vial that auto-assign placed in HPLC/Endo/Ster. Hiding
  // it when empty would lock users out of the override path.
  const showXtra = true

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="p-6">
        {plan.is_unreachable && (
          <div className="mb-4 p-3 rounded border border-amber-500/40 bg-amber-500/10 text-sm">
            Couldn't load order services from integration service — auto-assign skipped.
            Drag vials manually. Print still works.
          </div>
        )}
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `${showHplc ? '1fr ' : ''}${showMicro ? '1.2fr ' : ''}0.8fr`.trim(),
          }}
        >
          {showHplc && (
            <Bucket
              id="hplc"
              label="Analyses Dept."
              vials={plan.vials.filter(v => v.assignment_role === 'hplc')}
              demand={plan.demand.hplc}
              varianceN={plan.variance?.hplc ?? 0}
              baseDemand={plan.base_demand?.hplc ?? 0}
              onReset={() => handleResetBucket('hplc')}
            />
          )}
          {showMicro && (
            <MicroBucket
              endo={plan.vials.filter(v => v.assignment_role === 'endo')}
              ster={plan.vials.filter(v => v.assignment_role === 'ster')}
              endoDemand={plan.demand.endo}
              sterDemand={plan.demand.ster}
              endoVarianceN={plan.variance?.endo ?? 0}
              sterVarianceN={plan.variance?.ster ?? 0}
              onResetEndo={() => handleResetBucket('endo')}
              onResetSter={() => handleResetBucket('ster')}
            />
          )}
          {showXtra && (
            <Bucket
              id="xtra"
              label="Xtra"
              vials={plan.vials.filter(v => v.assignment_role === 'xtra' || v.assignment_role == null)}
              demand={null}
              onReset={null}
            />
          )}
        </div>
        <VarianceOverrideEditor
          parentSampleId={parentSampleId}
          plan={plan}
          refresh={refresh}
        />
        <AssignRemarksBlock
          parentSampleId={parentSampleId}
          parentSampleUid={parentSampleUid}
        />
      </div>
    </DndContext>
  )
}

/** Lab-side variance count override — interim until the WP variance addon ships. */
const VARIANCE_OVERRIDE_FIELDS = [
  { key: 'hplcpurity_identity', label: 'HPLC', ariaLabel: 'Variance HPLC' },
  { key: 'endotoxin', label: 'Endo', ariaLabel: 'Variance Endo' },
  { key: 'sterility_pcr', label: 'Sterility', ariaLabel: 'Variance Sterility' },
] as const

function VarianceOverrideEditor({
  parentSampleId,
  plan,
  refresh,
}: {
  parentSampleId: string
  plan: VialPlanResponse
  refresh: () => void
}) {
  const queryClient = useQueryClient()
  // Effective variance counts from the plan (0 when not set).
  const initialCounts = Object.fromEntries(
    VARIANCE_OVERRIDE_FIELDS.map(f => [
      f.key,
      plan.variance[f.key === 'hplcpurity_identity' ? 'hplc' : f.key === 'endotoxin' ? 'endo' : 'ster'] ?? 0,
    ])
  )
  const [counts, setCounts] = useState<Record<string, number>>(initialCounts)
  const [saving, setSaving] = useState(false)

  // Sync when plan changes (e.g. after a refresh)
  useEffect(() => {
    setCounts(Object.fromEntries(
      VARIANCE_OVERRIDE_FIELDS.map(f => [
        f.key,
        plan.variance[f.key === 'hplcpurity_identity' ? 'hplc' : f.key === 'endotoxin' ? 'endo' : 'ster'] ?? 0,
      ])
    ))
  }, [plan])

  async function handleSave() {
    setSaving(true)
    try {
      const map: Record<string, number> = {}
      for (const f of VARIANCE_OVERRIDE_FIELDS) {
        const n = counts[f.key] ?? 0
        if (n >= 2) map[f.key] = n
      }
      const payload = Object.keys(map).length > 0 ? map : null
      await putVarianceOverride(parentSampleId, payload)
      toast.success('Variance override saved')
      void refresh()
      queryClient.invalidateQueries({ queryKey: ['variance-entitlement', parentSampleId] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save variance override')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-6 pt-4 border-t border-border/60 max-w-2xl">
      <div className="mb-2">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium">Variance Testing</p>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="inline-flex items-center text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-help"
                aria-label="What does the variance count mean?"
              >
                <HelpCircle size={13} />
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm text-left space-y-1.5 p-3">
              <p className="font-semibold">Variance count = total replicates</p>
              <p>
                The number is the TOTAL samples tested from the lot,{' '}
                <span className="font-medium">including the canonical vial</span>.
                HPLC&nbsp;3 = the primary vial + 2 extra variance vials (the
                extras are what the client pays for: n&nbsp;−&nbsp;1).
              </p>
              <p>
                0 = no variance testing. 1 is meaningless (one sample is just
                the normal test) and is treated as none.
              </p>
              <p>
                Sterility already uses 2 vials per test — demand becomes the
                larger of that baseline and the variance count.
              </p>
              <p className="text-muted-foreground">
                Lab override: while set, it replaces the order&apos;s variance.
                Clearing all fields falls back to the WP order (none until the
                addon ships).
              </p>
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="text-xs text-muted-foreground">
          Lab override — replaces the order's variance until the WP addon ships. 0 = none,
          otherwise total replicates (≥2).
        </p>
      </div>
      <div className="flex items-end gap-3 flex-wrap">
        {VARIANCE_OVERRIDE_FIELDS.map(f => (
          <div key={f.key} className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground" htmlFor={`varov-${f.key}`}>
              {f.label}
            </label>
            <Input
              id={`varov-${f.key}`}
              type="number"
              min={0}
              aria-label={f.ariaLabel}
              value={counts[f.key] ?? 0}
              onChange={e =>
                setCounts(prev => ({ ...prev, [f.key]: parseInt(e.target.value, 10) || 0 }))
              }
              disabled={saving}
              className="w-20 text-sm"
            />
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={saving}
          aria-label="Save variance"
          className="cursor-pointer gap-1.5 self-end"
        >
          {saving && <Spinner className="size-3.5" />}
          Save
        </Button>
      </div>
    </div>
  )
}

/**
 * Add Remarks block — saves to the parent SENAITE AR. Vial assignment is the
 * step where missing vials, broken seals, mislabeled containers, etc. tend to
 * surface, so the assignment-tab gets the same remarks affordance as the
 * sample-detail page (the form text + save path mirror SampleDetails.AddRemarkForm).
 */
function AssignRemarksBlock({
  parentSampleId,
  parentSampleUid,
}: {
  parentSampleId: string
  parentSampleUid: string | null | undefined
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit() {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!parentSampleUid) {
      toast.error('Parent sample not loaded yet — try again in a moment.')
      return
    }
    setSaving(true)
    try {
      const result = await updateSenaiteSampleFields(parentSampleUid, { Remarks: trimmed })
      if (!result.success) throw new Error(result.message)
      toast.success(`Remark added to ${parentSampleId}`)
      setText('')
      setOpen(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      toast.error('Failed to add remark', { description: msg })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-6 pt-4 border-t border-border/60 max-w-2xl">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center gap-1.5"
        >
          <MessageSquare size={12} />
          Add remark to {parentSampleId}
        </button>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Remarks save to the parent sample ({parentSampleId}).
          </p>
          <Textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Missing vial, broken seal, label mismatch — note anything that came up during assignment..."
            disabled={saving}
            className="min-h-20 text-sm"
            aria-label={`Add remark to ${parentSampleId}`}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setOpen(false)
                setText('')
              }
            }}
          />
          <div className="flex items-center gap-2 justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false)
                setText('')
              }}
              disabled={saving}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSubmit}
              disabled={saving || !text.trim() || !parentSampleUid}
              className="cursor-pointer gap-1.5"
            >
              {saving && <Spinner className="size-3.5" />}
              Add Remark
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Bucket({
  id, label, vials, demand, onReset, varianceN = 0, baseDemand = 0,
}: {
  id: BucketId
  label: string
  vials: VialPlanItem[]
  demand: number | null
  onReset: (() => void) | null
  /** Variance n for this bucket (total replicates incl. canonical, 0 = none).
   *  Purely presentational: splits the count into base + variance lines.
   *  Vials are NOT individually designated — first fills base, surplus fills
   *  variance (spec: demand math, not vial designation). */
  varianceN?: number
  /** Pre-variance baseline demand for this bucket (from plan.base_demand). */
  baseDemand?: number
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const isShort = demand !== null && vials.length < demand
  const isFull = demand !== null && vials.length === demand

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'border-2 rounded-lg p-3 min-h-[120px] transition-colors',
        isOver
          ? 'border-primary bg-primary/5'
          : isFull
          ? 'border-solid border-primary/45'
          : isShort
          ? 'border-dashed border-amber-500/55 bg-amber-500/5'
          : 'border-dashed border-muted-foreground/35'
      )}
    >
      <header className="flex justify-between items-baseline mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        <strong className="text-foreground font-semibold">{label}</strong>
        <div className="flex items-center gap-2">
          {demand !== null && (
            <span className={cn(isShort && 'text-amber-500')}>
              {vials.length} / {demand}
              {isShort && ` — need ${demand - vials.length} more`}
            </span>
          )}
          {demand === null && <span>{vials.length}</span>}
          {onReset && vials.length > 0 && (
            <button
              type="button"
              onClick={onReset}
              className="text-[10px] underline hover:text-foreground"
              title="Reset to auto-assign"
            >
              <RotateCcw className="w-3 h-3 inline" /> reset
            </button>
          )}
        </div>
      </header>
      {varianceN >= 2 && demand !== null && demand > baseDemand && (
        <VarianceCountLines
          assigned={vials.length}
          baseSlots={baseDemand}
          extraSlots={demand - baseDemand}
          baseLabel={label === 'Analyses Dept.' ? 'HPLC' : label}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {vials.length === 0 && (
          <p className="text-xs text-muted-foreground italic">empty</p>
        )}
        {vials.map(v => <DraggableVial key={v.sample_id} vial={v} />)}
      </div>
    </div>
  )
}

function MicroBucket({
  endo, ster, endoDemand, sterDemand, endoVarianceN = 0, sterVarianceN = 0, onResetEndo, onResetSter,
}: {
  endo: VialPlanItem[]
  ster: VialPlanItem[]
  endoDemand: number
  sterDemand: number
  endoVarianceN?: number
  sterVarianceN?: number
  onResetEndo: () => void
  onResetSter: () => void
}) {
  const totalAssigned = endo.length + ster.length
  const totalDemand = endoDemand + sterDemand
  const isShort = totalAssigned < totalDemand

  return (
    <div
      className={cn(
        'border-2 rounded-lg p-3 min-h-[120px]',
        totalAssigned === totalDemand && totalDemand > 0
          ? 'border-solid border-primary/45'
          : isShort
          ? 'border-dashed border-amber-500/55 bg-amber-500/5'
          : 'border-dashed border-muted-foreground/35'
      )}
    >
      <header className="flex justify-between items-baseline mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        <strong className="text-foreground font-semibold">Microbiology</strong>
        <span className={cn(isShort && 'text-amber-500')}>
          {totalAssigned} / {totalDemand}
        </span>
      </header>
      {endoDemand > 0 && (
        <SubDropZone
          id="endo"
          label="Endo"
          vials={endo}
          demand={endoDemand}
          varianceN={endoVarianceN}
          onReset={onResetEndo}
        />
      )}
      {sterDemand > 0 && (
        <SubDropZone
          id="ster"
          label="Sterility"
          vials={ster}
          demand={sterDemand}
          varianceN={sterVarianceN}
          onReset={onResetSter}
        />
      )}
      {endoDemand === 0 && sterDemand === 0 && (
        <p className="text-xs text-muted-foreground italic">no addons</p>
      )}
    </div>
  )
}

/** Presentational base/variance count split for a variance bucket. The first
 *  `baseSlots` assignments fill the base line; surplus fills the variance
 *  line. No vial is individually marked — pure demand math (spec §2). */
function VarianceCountLines({
  assigned, baseSlots, extraSlots, baseLabel,
}: {
  assigned: number
  baseSlots: number
  extraSlots: number
  baseLabel: string
}) {
  const baseFilled = Math.min(assigned, baseSlots)
  const extraFilled = Math.max(0, Math.min(assigned - baseSlots, extraSlots))
  const baseShort = baseFilled < baseSlots
  const extraShort = extraFilled < extraSlots
  return (
    <div className="mb-2 space-y-0.5 text-[10px] uppercase tracking-wide">
      <div className={cn(baseShort ? 'text-amber-500' : 'text-muted-foreground')}>
        {baseLabel} · {baseFilled} / {baseSlots}{baseShort && ' ⚠'}
      </div>
      <div className={cn(extraShort ? 'text-amber-500' : 'text-muted-foreground')}>
        Variance · {extraFilled} / {extraSlots}{extraShort && ' ⚠'}
      </div>
    </div>
  )
}

function SubDropZone({
  id, label, vials, demand, onReset, varianceN = 0,
}: {
  id: BucketId
  label: string
  vials: VialPlanItem[]
  demand: number
  onReset: () => void
  varianceN?: number
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const isShort = vials.length < demand

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'pl-3 mt-2 border-l-2 transition-colors',
        isOver ? 'border-l-primary' : 'border-l-primary/25'
      )}
    >
      <div className={cn(
        'text-[10px] uppercase tracking-wide mb-1 flex justify-between',
        isShort ? 'text-amber-500' : 'text-muted-foreground'
      )}>
        <span>
          {label} · {vials.length} / {demand}
          {varianceN >= 2 && (
            <span className="text-sky-500"> (×{varianceN} variance)</span>
          )}
          {isShort && ' ⚠'}
        </span>
        {vials.length > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="underline hover:text-foreground"
          >
            <RotateCcw className="w-3 h-3 inline" /> reset
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {vials.map(v => <DraggableVial key={v.sample_id} vial={v} />)}
      </div>
    </div>
  )
}

function DraggableVial({ vial }: { vial: VialPlanItem }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: vial.sample_id,
  })
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined
  const role = vial.assignment_role ?? 'xtra'
  const roleColor = (
    role === 'hplc' ? 'bg-sky-400/25 text-sky-300' :
    role === 'endo' || role === 'ster' ? 'bg-violet-400/25 text-violet-300' :
    'bg-pink-400/25 text-pink-300'
  )
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={cn(
        'inline-flex items-center gap-2 px-2 py-1 rounded border text-xs font-mono cursor-grab active:cursor-grabbing select-none',
        vial.is_parent
          ? 'bg-teal-500/10 border-teal-500/45'
          : 'bg-indigo-500/10 border-indigo-500/35',
        isDragging && 'opacity-40'
      )}
    >
      <span>{vial.sample_id}</span>
      <span className={cn('text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wide', roleColor)}>
        {ROLE_SHORT[role]}
      </span>
    </div>
  )
}
