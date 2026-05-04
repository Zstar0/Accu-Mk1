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
import { Loader2, RotateCcw } from 'lucide-react'
import {
  getVialPlan,
  patchVialAssignment,
  type VialPlanResponse,
  type VialPlanItem,
  type AssignmentRole,
} from '@/lib/api'
import { cn } from '@/lib/utils'

interface Props {
  parentSampleId: string
}

const ROLE_SHORT: Record<string, string> = {
  hplc: 'HPLC',
  endo: 'ENDO',
  ster: 'STERYL',
  xtra: 'XTRA',
}

type BucketId = AssignmentRole

export function AssignStep({ parentSampleId }: Props) {
  const [plan, setPlan] = useState<VialPlanResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        // Roll back by re-fetching
        void refresh()
      }
    },
    [plan, refresh],
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
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        void refresh()
      }
    },
    [plan, refresh],
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
              onReset={() => handleResetBucket('hplc')}
            />
          )}
          {showMicro && (
            <MicroBucket
              endo={plan.vials.filter(v => v.assignment_role === 'endo')}
              ster={plan.vials.filter(v => v.assignment_role === 'ster')}
              endoDemand={plan.demand.endo}
              sterDemand={plan.demand.ster}
              onResetEndo={() => handleResetBucket('endo')}
              onResetSter={() => handleResetBucket('ster')}
            />
          )}
          {showXtra && (
            <Bucket
              id="xtra"
              label="Xtra"
              vials={plan.vials.filter(v => v.assignment_role === 'xtra')}
              demand={null}
              onReset={null}
            />
          )}
        </div>
      </div>
    </DndContext>
  )
}

function Bucket({
  id, label, vials, demand, onReset,
}: {
  id: BucketId
  label: string
  vials: VialPlanItem[]
  demand: number | null
  onReset: (() => void) | null
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
  endo, ster, endoDemand, sterDemand, onResetEndo, onResetSter,
}: {
  endo: VialPlanItem[]
  ster: VialPlanItem[]
  endoDemand: number
  sterDemand: number
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
          onReset={onResetEndo}
        />
      )}
      {sterDemand > 0 && (
        <SubDropZone
          id="ster"
          label="Sterility"
          vials={ster}
          demand={sterDemand}
          onReset={onResetSter}
        />
      )}
      {endoDemand === 0 && sterDemand === 0 && (
        <p className="text-xs text-muted-foreground italic">no addons</p>
      )}
    </div>
  )
}

function SubDropZone({
  id, label, vials, demand, onReset,
}: {
  id: BucketId
  label: string
  vials: VialPlanItem[]
  demand: number
  onReset: () => void
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
        <span>{label} · {vials.length} / {demand}{isShort && ' ⚠'}</span>
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
