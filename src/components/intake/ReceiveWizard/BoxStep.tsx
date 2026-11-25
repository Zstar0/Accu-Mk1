import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors,
  useDroppable, useDraggable,
  type DragEndEvent, type DragStartEvent, type KeyboardCoordinateGetter, type Modifier,
} from '@dnd-kit/core'
import { Printer, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { usePrintLabel } from '@/components/samples/usePrintLabel'
import { BoxLabelTemplate } from './BoxLabelTemplate'
import {
  listOrderBoxes, createBox, assignVialsToBox, unassignVialsFromBox, deleteBox, printBox,
  listSubSamples, type LimsBox, type SubSample,
} from '@/lib/api'
import { invalidateBoxCaches } from '@/lib/box-cache'
import { useVialRoles, type VialRoleRow } from '@/services/vial-roles'
import { useDepartments, type Department } from '@/services/departments'
import {
  ROLE_COLOR_BADGE,
  ROLE_COLOR_CHIP,
  ROLE_COLOR_TEXT,
  roleColorForCode,
  roleFullLabel,
  roleShortLabel,
} from '@/lib/role-display'

// Snap the drag preview's CENTER to the cursor. Without it, the overlay is
// offset by wherever inside the chip the grab started, so the "held" copy
// floats far from the pointer. Inline (not @dnd-kit/modifiers) to avoid a new
// dependency: shift the transform so the cursor lands at the chip's midpoint.
const snapCenterToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (draggingNodeRect && activatorEvent && 'clientX' in activatorEvent) {
    const e = activatorEvent as PointerEvent
    const offsetX = e.clientX - draggingNodeRect.left
    const offsetY = e.clientY - draggingNodeRect.top
    return {
      ...transform,
      x: transform.x + offsetX - draggingNodeRect.width / 2,
      y: transform.y + offsetY - draggingNodeRect.height / 2,
    }
  }
  return transform
}

const ARROW_CODES = new Set(['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'])

// Keyboard path for the vial→box move: arrow keys jump the lifted chip between
// enabled drop targets (box cards + the Unboxed tray) instead of dnd-kit's
// default 25px-per-keypress nudging, which is unusable across column-spread
// targets. Enter/Space on a focused chip lifts it, arrows pick the nearest
// target in that direction, Enter drops, Esc cancels. Exported for testing.
export const boxKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { context: { droppableRects, droppableContainers, collisionRect } },
) => {
  if (!ARROW_CODES.has(event.code) || !collisionRect) return undefined
  event.preventDefault()
  const cx = collisionRect.left + collisionRect.width / 2
  const cy = collisionRect.top + collisionRect.height / 2
  let best: { x: number; y: number } | undefined
  let bestDist = Infinity
  for (const container of droppableContainers.getEnabled()) {
    const rect = droppableRects.get(container.id)
    if (!rect) continue
    const dx = rect.left + rect.width / 2 - cx
    const dy = rect.top + rect.height / 2 - cy
    const inDirection =
      event.code === 'ArrowRight' ? dx > 1 :
      event.code === 'ArrowLeft' ? dx < -1 :
      event.code === 'ArrowDown' ? dy > 1 : dy < -1
    if (!inDirection) continue
    const dist = dx * dx + dy * dy
    if (dist < bestDist) {
      bestDist = dist
      // Coordinates are the lifted rect's new top-left: center the chip over
      // the target so collision detection resolves to exactly this droppable.
      best = {
        x: rect.left + (rect.width - collisionRect.width) / 2,
        y: rect.top + (rect.height - collisionRect.height) / 2,
      }
    }
  }
  return best
}

type BoxRole = string
// Columns are catalog-driven (spec 4, Task 10): the grid below renders one
// column per vial_roles row with boxable=true, ordered by sort_order — see
// BoxStep's useVialRoles() call. hm ships boxable=false today (spec-3
// Handler ruling, not reversed here), so it renders no column yet; flipping
// that flag in the Vial Roles admin page lights the column with zero code
// change (the dark-launch rehearsal this task's tests exercise).
//
// S1 roles-as-data: the label itself now comes from the catalog
// (roleFullLabel), not a hardcoded map — the hm entry (label "Heavy
// Metals") lives in the seeded catalog row, so it's already correct ahead
// of the boxable flip with zero code change here either.
// Exported for testing (same idiom as boxKeyboardCoordinates/boxLabelLines
// below).
export function roleLabel(role: string, roles?: VialRoleRow[]): string {
  return roleFullLabel(role, roles)
}

// S1 roles-as-data: badge/chip/text color, same catalog-then-department
// fallback chain as roleLabel above — every box/vial-chip surface in this
// file threads (roles, departments) through instead of a hardcoded map.
export function roleBadgeClassFor(role: string, roles?: VialRoleRow[], departments?: Department[]): string {
  return ROLE_COLOR_BADGE[roleColorForCode(role, roles, departments)]
}
export function roleTextClassFor(role: string, roles?: VialRoleRow[], departments?: Department[]): string {
  return ROLE_COLOR_TEXT[roleColorForCode(role, roles, departments)]
}
export function roleChipClassFor(role: string, roles?: VialRoleRow[], departments?: Department[]): string {
  return ROLE_COLOR_CHIP[roleColorForCode(role, roles, departments)]
}

// Default per-box capacity: the lab's smallest box holds 6 vials. Auto-assign
// fills up to the (possibly-edited) capacity; only this default is fixed at 6.
const DEFAULT_BOX_CAPACITY = 6

// The sub-sample shape returned by `listSubSamples` carries a `box_id` link
// (FK to lims_boxes.id) once the boxing backend has stamped it — null while
// unboxed. `SubSample.box_id` now exposes it; the alias is kept for readability.
type OrderVial = SubSample

/** Pure: the lines printed on a box label. Tested directly. */
export function boxLabelLines(box: LimsBox, roles?: VialRoleRow[]): string[] {
  const meta = `${roleShortLabel(box.role, roles)} · ${box.vial_count} vial${box.vial_count === 1 ? '' : 's'}`
  return [
    box.label_code,
    box.created_at ? `${meta} · ${box.created_at.slice(0, 10)}` : meta,
  ]
}

// --- Patch-on-confirm cache helpers -----------------------------------------
// The DB save lands in <100ms but a full awaited invalidateBoxCaches blocks
// ~5s on the ['order-vials'] refetch (one SENAITE listSubSamples call per
// sample). So each mutation handler patches the two caches this screen
// renders from — ['order-vials', orderKey, sampleIds] and
// ['order-boxes', orderKey] — straight from the API response as soon as the
// call confirms, then fires invalidateBoxCaches WITHOUT awaiting so the
// worksheet/sub-sample/active-boxes surfaces reconcile in the background.

/** Cancel in-flight refetches of the two order-scoped box queries so a stale
 *  response (from a previous op's background invalidation) can't land after
 *  the local patch and briefly revert it. */
async function cancelBoxRefetches(qc: QueryClient, orderKey: string): Promise<void> {
  await Promise.all([
    qc.cancelQueries({ queryKey: ['order-vials', orderKey] }),
    qc.cancelQueries({ queryKey: ['order-boxes', orderKey] }),
  ])
}

/** Set box_id on the moved vials in the ['order-vials'] cache (null = unboxed). */
function patchVialBoxIds(
  qc: QueryClient, orderKey: string, sampleIds: string[],
  movedIds: string[], boxId: number | null,
): void {
  qc.setQueryData<OrderVial[]>(['order-vials', orderKey, sampleIds], old =>
    old?.map(v => (movedIds.includes(v.sample_id) ? { ...v, box_id: boxId } : v)))
}

/** Apply a local transform to the ['order-boxes'] cache (replace/append/remove). */
function patchBoxes(
  qc: QueryClient, orderKey: string, fn: (old: LimsBox[]) => LimsBox[],
): void {
  qc.setQueryData<LimsBox[]>(['order-boxes', orderKey], old => (old ? fn(old) : old))
}

/** Adjust one box's vial_count by delta, clamped at ≥ 0. */
function adjustBoxCount(boxes: LimsBox[], boxId: number, delta: number): LimsBox[] {
  return boxes.map(b =>
    b.id === boxId ? { ...b, vial_count: Math.max(0, b.vial_count + delta) } : b)
}

interface Props {
  orderKey: string
  orderLabel: string
  /** Accepted (ReceiveWizard still passes it) but no longer printed — the
   *  box label now leads with the order key instead of a client line. */
  clientId: string | null
  sampleIds: string[]
}

export function BoxStep({ orderKey, orderLabel, sampleIds }: Props) {
  const qc = useQueryClient()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: boxKeyboardCoordinates }),
  )
  const { printNode } = usePrintLabel()

  // Capacity is frontend-only (ephemeral) — local per-box state driving the
  // Auto-assign batch size. Defaults to DEFAULT_BOX_CAPACITY (the lab's
  // smallest box); edit per-box when a larger box is used.
  const [capacities, setCapacities] = useState<Record<number, number>>({})
  // The vial being dragged, driving the DragOverlay preview ("holding the
  // item") and the source-chip dimming. Null while nothing is dragging.
  const [activeId, setActiveId] = useState<string | null>(null)
  // Count of in-flight save calls (assign/unassign/create/delete) driving the
  // "Saving…" indicator — a counter, not a boolean, so overlapping ops don't
  // clear it early.
  const [pendingSaves, setPendingSaves] = useState(0)
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

  const vialRolesQ = useVialRoles()
  const departmentsQ = useDepartments()
  const departments = departmentsQ.data

  const boxes = boxesQ.data ?? []
  const vials = (vialsQ.data ?? []).filter(v => v.assignment_role)

  // Columns are catalog-driven (spec 4, Task 10): every vial_roles row with
  // boxable=true that has at least one of this order's vials — boxed or not —
  // ordered by sort_order, UNIONED with any role that already has a box for
  // this order. The vial-presence gate is the 2026-09-01 ruling: as the
  // catalog grew past the original four roles, every boxable role painted an
  // empty lane and the grid overflowed; a role with nothing to box earns no
  // column. The union still matters twice over: a boxable flag flipped off
  // mid-flight, or a box left in a lane whose vials were since unassigned,
  // must not make an already-physical box vanish from the grid (same
  // invisibility class as Task 9's variance_eligible finding — stored
  // reality always wins over the flag). Unrecognized/no-longer-catalog codes
  // sort after every known one; roleLabel()'s fallback still labels them.
  //
  // boxableCodes is the STRICTER set (catalog boxable=true only) — used to
  // gate the "+ Add box" button and the auto-assign trailing-box create, so
  // a union-only column (existing box, flag now off) never offers a control
  // that would 400 against next_box's fail-closed boxable check
  // (backend/boxes/service.py). The column itself still renders — the union
  // above is what keeps it visible; this set only disables its NEW-box
  // affordances, never the existing box card or drag/drop onto it.
  const vialRoles = vialRolesQ.data ?? []
  const boxableCodes = new Set(vialRoles.filter(r => r.boxable).map(r => r.code))
  const sortOrderByCode = new Map(vialRoles.map(r => [r.code, r.sort_order]))
  const rolesWithVials = new Set(vials.map(v => v.assignment_role))
  const roles: BoxRole[] = Array.from(new Set([
    ...[...boxableCodes].filter(code => rolesWithVials.has(code)),
    ...boxes.map(b => b.role),
  ])).sort((a, b) => {
    const sa = sortOrderByCode.get(a) ?? Number.MAX_SAFE_INTEGER
    const sb = sortOrderByCode.get(b) ?? Number.MAX_SAFE_INTEGER
    return sa - sb || a.localeCompare(b)
  })

  // Auto-create — FIRST box only. A render effect (ref-guarded): for each role
  // with assigned-but-unboxed vials and zero boxes, mint exactly one box. The
  // ref closes the in-flight window before the box list refetches; once a box
  // of that role exists, `roleBoxes.length === 0` is false so it never refires.
  // Trailing boxes are NOT created here — that is the event-driven path in
  // `handleAutoAssign` below (no double-fire window, no ref needed).
  useEffect(() => {
    if (boxesQ.isLoading || vialsQ.isLoading || vialRolesQ.isLoading) return
    let cancelled = false
    const run = async () => {
      for (const role of roles) {
        const unboxed = vials.filter(v => v.assignment_role === role && !v.box_id)
        const roleBoxes = boxes.filter(b => b.role === role)
        const key = `${orderKey}:${role}`
        if (unboxed.length > 0 && roleBoxes.length === 0 && !autoCreatedRef.current.has(key)) {
          autoCreatedRef.current.add(key)
          await createBox(orderKey, role)
          if (cancelled) return
          await invalidateBoxCaches(qc, orderKey)
        }
      }
    }
    void run()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxesQ.data, vialsQ.data, vialRolesQ.data, boxesQ.isLoading, vialsQ.isLoading, vialRolesQ.isLoading, orderKey, qc])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id))
  }, [])

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    setActiveId(null)
    const { active, over } = event
    if (!over) return
    const subSampleId = String(active.id)
    setPendingSaves(n => n + 1)
    try {
      // The vial's current box, read from the cache — not the closed-over
      // `vials` array, which is stale inside this useCallback.
      const prevBoxId = qc.getQueryData<OrderVial[]>(['order-vials', orderKey, sampleIds])
        ?.find(v => v.sample_id === subSampleId)?.box_id ?? null
      if (over.id === 'unboxed') {
        // Dropped on the Unboxed tray → clear box membership.
        await unassignVialsFromBox([subSampleId])
        await cancelBoxRefetches(qc, orderKey)
        patchVialBoxIds(qc, orderKey, sampleIds, [subSampleId], null)
        if (prevBoxId != null) {
          patchBoxes(qc, orderKey, old => adjustBoxCount(old, prevBoxId, -1))
        }
      } else {
        // Dropped on a box column → assign to that (numeric) box id.
        const boxId = Number(over.id)
        if (!boxId) return
        const updated = await assignVialsToBox(boxId, [subSampleId])
        await cancelBoxRefetches(qc, orderKey)
        patchVialBoxIds(qc, orderKey, sampleIds, [subSampleId], boxId)
        patchBoxes(qc, orderKey, old => old.map(b => (b.id === updated.id ? updated : b)))
        if (prevBoxId != null && prevBoxId !== boxId) {
          patchBoxes(qc, orderKey, old => adjustBoxCount(old, prevBoxId, -1))
        }
      }
      void invalidateBoxCaches(qc, orderKey)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to move ${subSampleId}`)
    } finally {
      setPendingSaves(n => Math.max(0, n - 1))
    }
  }, [qc, orderKey, sampleIds])

  const addBox = async (role: BoxRole) => {
    setPendingSaves(n => n + 1)
    try {
      const created = await createBox(orderKey, role)
      await cancelBoxRefetches(qc, orderKey)
      patchBoxes(qc, orderKey, old => [...old, created])
      void invalidateBoxCaches(qc, orderKey)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add box')
    } finally {
      setPendingSaves(n => Math.max(0, n - 1))
    }
  }

  // Auto-assign(box): fill up to `capacity - vial_count` of this box's role's
  // unboxed vials, then — in the SAME handler (an event, not a render effect) —
  // create the trailing box if the role still has unboxed vials and no empty
  // box exists. Doing it here means no double-fire window, so no ref guard.
  const handleAutoAssign = async (box: LimsBox) => {
    const role = box.role
    const roleUnboxed = vials.filter(v => v.assignment_role === role && !v.box_id)
    const capacity = capacities[box.id] ?? DEFAULT_BOX_CAPACITY
    const take = Math.max(0, capacity - box.vial_count)
    const takenIds = roleUnboxed.slice(0, take).map(v => v.sample_id)
    setPendingSaves(n => n + 1)
    try {
      if (takenIds.length > 0) {
        const updated = await assignVialsToBox(box.id, takenIds)
        await cancelBoxRefetches(qc, orderKey)
        // Taken vials were all unboxed, so no source-box decrement is needed.
        patchVialBoxIds(qc, orderKey, sampleIds, takenIds, box.id)
        patchBoxes(qc, orderKey, old => old.map(b => (b.id === updated.id ? updated : b)))
        void invalidateBoxCaches(qc, orderKey)
      }
      const remaining = roleUnboxed.slice(take)
      const otherEmptyBox = boxes.some(b => b.id !== box.id && b.role === role && b.vial_count === 0)
      const thisBoxStillEmpty = box.vial_count + takenIds.length === 0
      // boxableCodes-gated: a role kept on the grid only via the existing-box
      // union (its catalog boxable flag is now false) can't mint a NEW box —
      // createBox -> next_box is fail-closed on boxable server-side.
      if (remaining.length > 0 && !otherEmptyBox && !thisBoxStillEmpty && boxableCodes.has(role)) {
        const created = await createBox(orderKey, role)
        await cancelBoxRefetches(qc, orderKey)
        patchBoxes(qc, orderKey, old => [...old, created])
        void invalidateBoxCaches(qc, orderKey)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Auto-assign failed')
    } finally {
      setPendingSaves(n => Math.max(0, n - 1))
    }
  }

  const handleRemoveBox = async (box: LimsBox) => {
    setPendingSaves(n => n + 1)
    try {
      await deleteBox(box.id)
      await cancelBoxRefetches(qc, orderKey)
      patchBoxes(qc, orderKey, old => old.filter(b => b.id !== box.id))
      // The backend returns the deleted box's vials to Unboxed — mirror that.
      const orphanedIds = (qc.getQueryData<OrderVial[]>(['order-vials', orderKey, sampleIds]) ?? [])
        .filter(v => v.box_id === box.id).map(v => v.sample_id)
      patchVialBoxIds(qc, orderKey, sampleIds, orphanedIds, null)
      void invalidateBoxCaches(qc, orderKey)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to delete ${box.label_code}`)
    } finally {
      setPendingSaves(n => Math.max(0, n - 1))
    }
  }

  // vialRolesQ loading is included: rendering an empty grid before the
  // catalog resolves would flash zero columns, then pop in the real set.
  if (boxesQ.isLoading || vialsQ.isLoading || vialRolesQ.isLoading) {
    return <div className="p-6">Loading…</div>
  }

  const unboxedVials = vials.filter(v => !v.box_id)
  const activeVial = activeId ? vials.find(v => v.sample_id === activeId) ?? null : null

  // Every vialed box of the order, in the same role/box order as the columns
  // below — one physical label each in a single print job.
  const printableBoxes = roles.flatMap(role =>
    boxes.filter(b => b.role === role && b.vial_count > 0))

  const handlePrintAllLabels = () => {
    // One print job: a fragment of .label nodes — the print CSS page-breaks
    // on .label, so each box lands on its own strip (same idiom as PrintStep
    // printing many labels in one window.print()).
    printNode(
      <>
        {printableBoxes.map(b => (
          <BoxLabelTemplate key={b.id} boxId={b.id} labelCode={b.label_code}
            role={b.role} vialCount={b.vial_count} createdAt={b.created_at} roles={vialRoles} />
        ))}
      </>,
    )
    // Stamp printed_at on each box, same as the per-box button does, then
    // refresh the box surfaces so the buttons flip to "Reprint".
    void Promise.all(printableBoxes.map(b => printBox(b.id)))
      .then(() => invalidateBoxCaches(qc, orderKey))
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}>
      <div className="p-6 flex flex-col gap-4 h-full overflow-hidden">
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="sm" className="gap-2"
            onClick={handlePrintAllLabels} disabled={printableBoxes.length === 0}>
            <Printer className="w-4 h-4" aria-hidden="true" />
            Print box labels
          </Button>
          {pendingSaves > 0 && <span className="text-xs text-muted-foreground animate-pulse">Saving…</span>}
        </div>
        <div className="flex gap-4 flex-1 min-h-0">
          {/* LEFT: per-role box columns + in-column drop targets (manual override).
              Column count follows `roles` (catalog-driven, Task 10) — a fixed
              Tailwind grid-cols-N can't survive a variable role count, so the
              template is computed inline. */}
          <div className="flex-1 grid gap-4 overflow-y-auto"
            style={{ gridTemplateColumns: `repeat(${Math.max(roles.length, 1)}, minmax(0, 1fr))` }}>
            {roles.map(role => {
              return (
                <div key={role} className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <h3 className={`font-semibold ${roleTextClassFor(role, vialRoles, departments)}`}>{roleLabel(role, vialRoles)}</h3>
                    {/* Disabled (not hidden) when this column is on the grid
                        only via the existing-box union: the column and its
                        boxes stay usable, but minting a NEW box for a role
                        the catalog no longer marks boxable would 400. */}
                    <Button size="sm" variant="outline" onClick={() => void addBox(role)}
                      disabled={!boxableCodes.has(role)}
                      title={boxableCodes.has(role) ? undefined : 'This role is no longer boxable in the catalog'}>
                      + Add box
                    </Button>
                  </div>
                  {boxes.filter(b => b.role === role).map(b => (
                    <BoxCard
                      key={b.id}
                      box={b}
                      boxVials={vials.filter(v => v.box_id === b.id)}
                      capacity={capacities[b.id] ?? DEFAULT_BOX_CAPACITY}
                      activeId={activeId}
                      onCapacityChange={n => setCapacities(c => ({ ...c, [b.id]: n }))}
                      onAutoAssign={() => void handleAutoAssign(b)}
                      onRemove={() => void handleRemoveBox(b)}
                      roles={vialRoles}
                      departments={departments}
                    />
                  ))}
                </div>
              )
            })}
          </div>

          {/* RIGHT: unboxed vials, grouped by role — drag source for overrides and
              a drop target: drag a boxed chip here to clear its box membership. */}
          <UnboxedPanel orderLabel={orderLabel} vials={unboxedVials} activeId={activeId} roles={roles}
            vialRoles={vialRoles} departments={departments} />
        </div>
      </div>

      {/* The "held" preview — a role-colored copy tracking the cursor. The
          center snaps to the pointer; dropAnimation is disabled so the chip
          doesn't fly back to its old box before the reassign state lands
          (which reads backwards). */}
      <DragOverlay dropAnimation={null} modifiers={[snapCenterToCursor]}>
        {activeVial ? (
          <span className={`cursor-grabbing rounded ${roleChipClassFor(activeVial.assignment_role ?? '', vialRoles, departments)} px-2 py-0.5 font-mono text-xs`}>
            {activeVial.sample_id}
          </span>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function UnboxedPanel({ orderLabel, vials, activeId, roles, vialRoles, departments }:
  { orderLabel: string; vials: OrderVial[]; activeId: string | null; roles: string[]; vialRoles?: VialRoleRow[]; departments?: Department[] }) {
  // Sentinel-id droppable: dropping a boxed chip here unassigns it (drag out).
  const { setNodeRef, isOver } = useDroppable({ id: 'unboxed' })
  return (
    <div ref={setNodeRef}
      className={`w-56 shrink-0 overflow-y-auto rounded border p-3 ${isOver ? 'ring-2 ring-primary' : ''}`}>
      <div className="mb-2 text-sm font-semibold">Unboxed ({orderLabel})</div>
      {roles.map(role => {
        const rv = vials.filter(v => v.assignment_role === role)
        if (rv.length === 0) return null
        return (
          <div key={role} className="mb-2">
            <div className={`mb-1 text-xs ${roleTextClassFor(role, vialRoles, departments)}`}>{roleLabel(role, vialRoles)}</div>
            <div className="flex flex-wrap gap-1">
              {rv.map(v => (
                <VialChip key={v.sample_id} id={v.sample_id} role={role} dimmed={activeId === v.sample_id}
                  roles={vialRoles} departments={departments} />
              ))}
            </div>
          </div>
        )
      })}
      {vials.length === 0 && <div className="text-xs text-muted-foreground">All vials boxed.</div>}
    </div>
  )
}

function VialChip({ id, role, dimmed, roles, departments }: {
  id: string
  role: string
  dimmed?: boolean
  roles?: VialRoleRow[]
  departments?: Department[]
}) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id })
  return (
    <span ref={setNodeRef} {...listeners} {...attributes}
      className={`cursor-grab rounded ${roleChipClassFor(role, roles, departments)} px-2 py-0.5 font-mono text-xs ${dimmed ? 'opacity-40' : ''}`}>
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
  capacity: number
  activeId: string | null
  onCapacityChange: (n: number) => void
  onAutoAssign: () => void
  onRemove: () => void
  // Threaded to the print template below — a print template must not grow
  // its own query hook.
  roles?: VialRoleRow[]
  departments?: Department[]
}

function BoxCard({ box, boxVials, capacity, activeId, onCapacityChange, onAutoAssign, onRemove, roles, departments }: BoxCardProps) {
  const qc = useQueryClient()
  const { setNodeRef, isOver } = useDroppable({ id: String(box.id) })
  const { printNode } = usePrintLabel()
  return (
    <div ref={setNodeRef}
      className={`rounded border p-2 ${roleBadgeClassFor(box.role, roles, departments)} ${isOver ? 'ring-2 ring-primary' : ''}`}>
      <div className="flex items-center justify-between">
        <span className={`font-mono font-semibold ${roleTextClassFor(box.role, roles, departments)}`}>{box.label_code}</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" className="gap-2"
            onClick={() => { void printBox(box.id).then(() => invalidateBoxCaches(qc, box.order_key)); printNode(
              <BoxLabelTemplate boxId={box.id} labelCode={box.label_code}
                role={box.role} vialCount={box.vial_count} createdAt={box.created_at} roles={roles} />,
            ) }}>
            <Printer className="w-4 h-4" aria-hidden="true" />
            {box.printed_at ? 'Reprint' : 'Print label'}
          </Button>
          <Button size="sm" variant="ghost" aria-label="Delete box"
            className="text-destructive hover:text-destructive"
            onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="text-xs text-muted-foreground">{box.vial_count} vials</div>
      {boxVials.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {boxVials.map(v => (
            <VialChip key={v.sample_id} id={v.sample_id} role={v.assignment_role ?? ''}
              dimmed={activeId === v.sample_id} roles={roles} departments={departments} />
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
