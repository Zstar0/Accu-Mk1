import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext, PointerSensor, useSensor, useSensors, useDroppable, useDraggable,
  type DragEndEvent,
} from '@dnd-kit/core'
import { Button } from '@/components/ui/button'
import { usePrintLabel } from '@/components/samples/usePrintLabel'
import { BoxLabelTemplate } from './BoxLabelTemplate'
import {
  listOrderBoxes, createBox, assignVialsToBox, deleteBox, printBox,
  listSubSamples, type LimsBox, type SubSample,
} from '@/lib/api'
import { ROLE_CHIP_CLASS, roleBadgeClass, roleTextClass } from '@/lib/assignment-colors'

type BoxRole = 'hplc' | 'endo' | 'ster'
const ROLE_LABEL: Record<BoxRole, string> = { hplc: 'HPLC', endo: 'Endotoxin', ster: 'Sterility' }
const ROLES: BoxRole[] = ['hplc', 'endo', 'ster']

// Default per-box capacity: the lab's smallest box holds 6 vials. Auto-assign
// fills up to the (possibly-edited) capacity; only this default is fixed at 6.
const DEFAULT_BOX_CAPACITY = 6

// The sub-sample shape returned by `listSubSamples` carries a `box_id` link
// (FK to lims_boxes.id) once the boxing backend has stamped it — null while
// unboxed. `SubSample.box_id` now exposes it; the alias is kept for readability.
type OrderVial = SubSample

/** Pure: the lines printed on a box label. Tested directly. */
export function boxLabelLines(box: LimsBox, clientName: string | null): string[] {
  const lines = [box.label_code]
  if (clientName) lines.push(clientName)
  lines.push(`${ROLE_LABEL[box.role as BoxRole]} · ${box.vial_count} vials`)
  return lines
}

interface Props {
  orderKey: string
  orderLabel: string
  clientId: string | null
  sampleIds: string[]
}

export function BoxStep({ orderKey, orderLabel, clientId, sampleIds }: Props) {
  const qc = useQueryClient()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  // Capacity is frontend-only (ephemeral) — local per-box state driving the
  // Auto-assign batch size. Defaults to DEFAULT_BOX_CAPACITY (the lab's
  // smallest box); edit per-box when a larger box is used.
  const [capacities, setCapacities] = useState<Record<number, number>>({})
  // Guards the in-flight window of the first-box auto-create effect so a
  // refetch/HMR never double-creates. Keyed `${orderKey}:${role}`.
  const autoCreatedRef = useRef<Set<string>>(new Set())

  const boxesQ = useQuery({ queryKey: ['order-boxes', orderKey], queryFn: () => listOrderBoxes(orderKey) })

  // The order's vials across all its samples (each sample's vials loaded once).
  const vialsQ = useQuery({
    queryKey: ['order-vials', orderKey, sampleIds],
    queryFn: async (): Promise<OrderVial[]> => {
      const lists = await Promise.all(sampleIds.map(id => listSubSamples(id)))
      return lists.flatMap(l => l.sub_samples)
    },
  })

  const boxes = boxesQ.data ?? []
  const vials = (vialsQ.data ?? []).filter(v => v.assignment_role && v.assignment_role !== 'xtra')

  // Auto-create — FIRST box only. A render effect (ref-guarded): for each role
  // with assigned-but-unboxed vials and zero boxes, mint exactly one box. The
  // ref closes the in-flight window before the box list refetches; once a box
  // of that role exists, `roleBoxes.length === 0` is false so it never refires.
  // Trailing boxes are NOT created here — that is the event-driven path in
  // `handleAutoAssign` below (no double-fire window, no ref needed).
  useEffect(() => {
    if (boxesQ.isLoading || vialsQ.isLoading) return
    let cancelled = false
    const run = async () => {
      for (const role of ROLES) {
        const unboxed = vials.filter(v => v.assignment_role === role && !v.box_id)
        const roleBoxes = boxes.filter(b => b.role === role)
        const key = `${orderKey}:${role}`
        if (unboxed.length > 0 && roleBoxes.length === 0 && !autoCreatedRef.current.has(key)) {
          autoCreatedRef.current.add(key)
          await createBox(orderKey, role)
          if (cancelled) return
          await qc.invalidateQueries({ queryKey: ['order-boxes', orderKey] })
        }
      }
    }
    void run()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxesQ.data, vialsQ.data, boxesQ.isLoading, vialsQ.isLoading, orderKey, qc])

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const subSampleId = String(event.active.id)
    const boxId = event.over?.id ? Number(event.over.id) : null
    if (!boxId) return
    await assignVialsToBox(boxId, [subSampleId])
    await qc.invalidateQueries({ queryKey: ['order-boxes', orderKey] })
    await qc.invalidateQueries({ queryKey: ['order-vials', orderKey] })
  }, [qc, orderKey])

  const addBox = async (role: BoxRole) => {
    await createBox(orderKey, role)
    await qc.invalidateQueries({ queryKey: ['order-boxes', orderKey] })
  }

  // Auto-assign(box): fill up to `capacity - vial_count` of this box's role's
  // unboxed vials, then — in the SAME handler (an event, not a render effect) —
  // create the trailing box if the role still has unboxed vials and no empty
  // box exists. Doing it here means no double-fire window, so no ref guard.
  const handleAutoAssign = async (box: LimsBox) => {
    const role = box.role as BoxRole
    const roleUnboxed = vials.filter(v => v.assignment_role === role && !v.box_id)
    const capacity = capacities[box.id] ?? DEFAULT_BOX_CAPACITY
    const take = Math.max(0, capacity - box.vial_count)
    const takenIds = roleUnboxed.slice(0, take).map(v => v.sample_id)
    if (takenIds.length > 0) {
      await assignVialsToBox(box.id, takenIds)
      await qc.invalidateQueries({ queryKey: ['order-boxes', orderKey] })
      await qc.invalidateQueries({ queryKey: ['order-vials', orderKey] })
    }
    const remaining = roleUnboxed.slice(take)
    const otherEmptyBox = boxes.some(b => b.id !== box.id && b.role === role && b.vial_count === 0)
    const thisBoxStillEmpty = box.vial_count + takenIds.length === 0
    if (remaining.length > 0 && !otherEmptyBox && !thisBoxStillEmpty) {
      await createBox(orderKey, role)
      await qc.invalidateQueries({ queryKey: ['order-boxes', orderKey] })
    }
  }

  const handleRemoveBox = async (box: LimsBox) => {
    await deleteBox(box.id)
    await qc.invalidateQueries({ queryKey: ['order-boxes', orderKey] })
  }

  if (boxesQ.isLoading || vialsQ.isLoading) return <div className="p-6">Loading…</div>

  const unboxedVials = vials.filter(v => !v.box_id)

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="p-6 flex gap-4 h-full overflow-hidden">
        {/* LEFT: per-role box columns + in-column drop targets (manual override). */}
        <div className="flex-1 grid grid-cols-3 gap-4 overflow-y-auto">
          {ROLES.map(role => {
            return (
              <div key={role} className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h3 className={`font-semibold ${roleTextClass(role)}`}>{ROLE_LABEL[role]}</h3>
                  <Button size="sm" variant="outline" onClick={() => void addBox(role)}>+ Add box</Button>
                </div>
                {boxes.filter(b => b.role === role).map(b => (
                  <BoxCard
                    key={b.id}
                    box={b}
                    boxVials={vials.filter(v => v.box_id === b.id)}
                    clientName={clientId}
                    capacity={capacities[b.id] ?? DEFAULT_BOX_CAPACITY}
                    onCapacityChange={n => setCapacities(c => ({ ...c, [b.id]: n }))}
                    onAutoAssign={() => void handleAutoAssign(b)}
                    onRemove={() => void handleRemoveBox(b)}
                  />
                ))}
              </div>
            )
          })}
        </div>

        {/* RIGHT: unboxed vials, grouped by role — drag source for overrides. */}
        <UnboxedPanel orderLabel={orderLabel} vials={unboxedVials} />
      </div>
    </DndContext>
  )
}

function UnboxedPanel({ orderLabel, vials }: { orderLabel: string; vials: OrderVial[] }) {
  return (
    <div className="w-56 shrink-0 overflow-y-auto rounded border p-3">
      <div className="mb-2 text-sm font-semibold">Unboxed ({orderLabel})</div>
      {ROLES.map(role => {
        const rv = vials.filter(v => v.assignment_role === role)
        if (rv.length === 0) return null
        return (
          <div key={role} className="mb-2">
            <div className={`mb-1 text-xs ${roleTextClass(role)}`}>{ROLE_LABEL[role]}</div>
            <div className="flex flex-wrap gap-1">
              {rv.map(v => <VialChip key={v.sample_id} id={v.sample_id} role={role} />)}
            </div>
          </div>
        )
      })}
      {vials.length === 0 && <div className="text-xs text-muted-foreground">All vials boxed.</div>}
    </div>
  )
}

function VialChip({ id, role }: { id: string; role: string }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id })
  return (
    <span ref={setNodeRef} {...listeners} {...attributes}
      className={`cursor-grab rounded ${ROLE_CHIP_CLASS[role] ?? 'bg-muted'} px-2 py-0.5 font-mono text-xs`}>
      {id}
    </span>
  )
}

interface BoxCardProps {
  box: LimsBox
  // The order's vials already assigned to THIS box (box_id === box.id).
  // Rendered inside the card as draggable chips so the tech sees what landed
  // where and can drag a chip onto another box to reassign it.
  boxVials: OrderVial[]
  clientName: string | null
  capacity: number
  onCapacityChange: (n: number) => void
  onAutoAssign: () => void
  onRemove: () => void
}

function BoxCard({ box, boxVials, clientName, capacity, onCapacityChange, onAutoAssign, onRemove }: BoxCardProps) {
  const { setNodeRef, isOver } = useDroppable({ id: String(box.id) })
  const { printNode } = usePrintLabel()
  return (
    <div ref={setNodeRef}
      className={`rounded border p-2 ${roleBadgeClass(box.role)} ${isOver ? 'ring-2 ring-primary' : ''}`}>
      <div className="flex items-center justify-between">
        <span className={`font-mono font-semibold ${roleTextClass(box.role)}`}>{box.label_code}</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost"
            onClick={() => { void printBox(box.id); printNode(
              <BoxLabelTemplate labelCode={box.label_code} clientName={clientName}
                role={box.role} vialCount={box.vial_count} />,
            ) }}>
            {box.printed_at ? 'Reprint' : 'Print label'}
          </Button>
          {box.vial_count === 0 && (
            <Button size="sm" variant="ghost" aria-label="Remove box"
              onClick={onRemove}>×</Button>
          )}
        </div>
      </div>
      <div className="text-xs text-muted-foreground">{box.vial_count} vials</div>
      {boxVials.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {boxVials.map(v => (
            <VialChip key={v.sample_id} id={v.sample_id} role={v.assignment_role ?? ''} />
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-1">
        <label className="text-xs text-muted-foreground" htmlFor={`cap-${box.id}`}>Cap</label>
        <input
          id={`cap-${box.id}`}
          type="number"
          min={0}
          aria-label="Capacity"
          value={capacity}
          onChange={e => onCapacityChange(Number(e.target.value))}
          className="w-16 rounded border px-1 py-0.5 text-xs"
        />
        <Button size="sm" variant="outline" onClick={onAutoAssign}>Auto-assign</Button>
      </div>
    </div>
  )
}
