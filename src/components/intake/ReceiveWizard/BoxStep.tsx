import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext, PointerSensor, useSensor, useSensors, useDroppable, useDraggable,
  type DragEndEvent,
} from '@dnd-kit/core'
import { Button } from '@/components/ui/button'
import { usePrintLabel } from '@/components/samples/usePrintLabel'
import { BoxLabelTemplate } from './BoxLabelTemplate'
import {
  listOrderBoxes, createBox, assignVialsToBox, printBox,
  listSubSamples, type LimsBox, type SubSample,
} from '@/lib/api'

type BoxRole = 'hplc' | 'endo' | 'ster'
const ROLE_LABEL: Record<BoxRole, string> = { hplc: 'HPLC', endo: 'Endotoxin', ster: 'Sterility' }

// The sub-sample shape returned by `listSubSamples` carries a `box_id` link
// once the boxing backend has stamped it. The base `SubSample` type predates
// that column, so widen locally (box_id optional) rather than touch api.ts.
type OrderVial = SubSample & { box_id?: number | null }

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

export function BoxStep({ orderKey, clientId, sampleIds }: Props) {
  const qc = useQueryClient()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const boxesQ = useQuery({ queryKey: ['order-boxes', orderKey], queryFn: () => listOrderBoxes(orderKey) })

  // The order's vials across all its samples (each sample's vials loaded once).
  const vialsQ = useQuery({
    queryKey: ['order-vials', orderKey, sampleIds],
    queryFn: async (): Promise<OrderVial[]> => {
      const lists = await Promise.all(sampleIds.map(id => listSubSamples(id)))
      return lists.flatMap(l => l.sub_samples)
    },
  })

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

  if (boxesQ.isLoading || vialsQ.isLoading) return <div className="p-6">Loading…</div>
  const boxes = boxesQ.data ?? []
  const vials = (vialsQ.data ?? []).filter(v => v.assignment_role && v.assignment_role !== 'xtra')

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="p-6 grid grid-cols-3 gap-4 overflow-y-auto h-full">
        {(['hplc', 'endo', 'ster'] as BoxRole[]).map(role => (
          <div key={role} className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{ROLE_LABEL[role]}</h3>
              <Button size="sm" variant="outline" onClick={() => void addBox(role)}>+ Add box</Button>
            </div>
            <UnboxedTray
              role={role}
              vials={vials.filter(v => v.assignment_role === role && !v.box_id)}
            />
            {boxes.filter(b => b.role === role).map(b => (
              <BoxCard key={b.id} box={b} clientName={clientId} />
            ))}
          </div>
        ))}
      </div>
    </DndContext>
  )
}

function UnboxedTray({ role, vials }: { role: BoxRole; vials: { sample_id: string }[] }) {
  return (
    <div className="rounded border border-dashed p-2 min-h-12">
      <div className="text-xs text-muted-foreground mb-1">Unboxed {ROLE_LABEL[role]}</div>
      <div className="flex flex-wrap gap-1">
        {vials.map(v => <VialChip key={v.sample_id} id={v.sample_id} />)}
      </div>
    </div>
  )
}

function VialChip({ id }: { id: string }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id })
  return (
    <span ref={setNodeRef} {...listeners} {...attributes}
      className="cursor-grab rounded bg-muted px-2 py-0.5 font-mono text-xs">
      {id}
    </span>
  )
}

function BoxCard({ box, clientName }: { box: LimsBox; clientName: string | null }) {
  const { setNodeRef, isOver } = useDroppable({ id: String(box.id) })
  const { printNode } = usePrintLabel()
  return (
    <div ref={setNodeRef}
      className={`rounded border p-2 ${isOver ? 'ring-2 ring-primary' : ''}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono font-semibold">{box.label_code}</span>
        <Button size="sm" variant="ghost"
          onClick={() => { void printBox(box.id); printNode(
            <BoxLabelTemplate labelCode={box.label_code} clientName={clientName}
              role={box.role} vialCount={box.vial_count} />,
          ) }}>
          {box.printed_at ? 'Reprint' : 'Print label'}
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">{box.vial_count} vials</div>
    </div>
  )
}
