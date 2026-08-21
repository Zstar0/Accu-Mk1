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
import { CornerDownRight, HelpCircle, Loader2, MessageSquare, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import {
  ApiCodeError,
  getVialPlan,
  patchVialAssignment,
  putVarianceOverride,
  updateSenaiteSampleFields,
  type VialPlanResponse,
  type VialPlanItem,
  type VialPlanSection,
  type VialPlanRoleProfile,
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
import { useVialRoles } from '@/services/vial-roles'
import { useDepartments } from '@/services/departments'
import { ROLE_COLOR_CHIP, roleColorForCode, roleShortLabel } from '@/lib/role-display'

/** A role code → short display string. Bound to the vial_roles catalog data
 *  once, in AssignStep (the only useVialRoles() call in this tree), then
 *  threaded down as a prop — every nested section/bucket/chip below stays a
 *  plain function taking this as a parameter instead of growing its own
 *  query hook. */
type RoleShortFn = (code: string) => string
/** A role code → chip class string, threaded alongside RoleShortFn from the
 *  same AssignStep catalog reads (useVialRoles + useDepartments). */
type RoleColorFn = (code: string) => string

interface Props {
  parentSampleId: string
  /** SENAITE UID of the parent — required for saving remarks to the AR.
   *  Optional so the component still renders if the lookup is in flight. */
  parentSampleUid?: string | null
}

// Widened to string alongside AssignmentRole (spec 4, Task 8/9): a
// catalog-driven bench mints droppable ids from any role code the catalog
// carries, not just the legacy three variance buckets.
type BucketId = string

/** Maps a droppable bucket id to the (role, kind) tuple sent to the server.
 *  Variance buckets map to kind='variance'; core buckets to kind='core';
 *  'xtra' maps to kind=null (never assigned a specific kind). */
export function bucketToAssignment(b: string): { role: string; kind: 'core' | 'variance' | null } {
  if (b.endsWith('_variance')) return { role: b.replace('_variance', ''), kind: 'variance' }
  if (b === 'xtra') return { role: 'xtra', kind: null }
  return { role: b, kind: 'core' }
}

/** plan.variance stays the legacy fixed shape {hplc, endo, ster} BY CONTRACT
 *  (derive_variance_demand never emits a catalog-only role like hm/t_role —
 *  Task 3). An explicit lookup — rather than a cast to an indexed type —
 *  keeps that contract visible at the call site instead of hidden behind a
 *  cast that would silently paper over a real code drifting outside it. */
function varianceFor(variance: VialPlanResponse['variance'], code: string): number {
  if (code === 'hplc') return variance.hplc
  if (code === 'endo') return variance.endo
  if (code === 'ster') return variance.ster
  return 0
}

/** Routes an assignment PATCH failure to the right toast. Branches on the
 *  structured ApiCodeError.code (never message text) — 409 variance_locked
 *  gets a distinct, actionable message. Exported for tests: drag simulation
 *  isn't jsdom-feasible, so the branch is locked via this helper. */
export function toastAssignmentError(e: unknown): void {
  if (e instanceof ApiCodeError && e.code === 'variance_locked') {
    toast.error('Variance assignment locked', {
      description: "This sample's variance set is locked. Unlock it before re-assigning vials.",
    })
    return
  }
  toast.error('Assignment failed', {
    description: e instanceof Error ? e.message : String(e),
  })
}

export function AssignStep({ parentSampleId, parentSampleUid }: Props) {
  const [plan, setPlan] = useState<VialPlanResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  // S1 roles-as-data: AssignStep's vial-plan sections carry full labels but
  // not short forms — the one useVialRoles() call for this tree.
  const vialRolesQ = useVialRoles()
  const departmentsQ = useDepartments()
  const roleShort: RoleShortFn = code => roleShortLabel(code, vialRolesQ.data)
  const roleColor: RoleColorFn = code =>
    ROLE_COLOR_CHIP[roleColorForCode(code, vialRolesQ.data, departmentsQ.data)]

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
      const targetBucket = event.over?.id ? (String(event.over.id) as BucketId) : null
      if (!targetBucket) return
      const { role, kind } = bucketToAssignment(targetBucket)
      const assignRole = role as AssignmentRole
      // Optimistic update: store role + kind on the vial
      const prevPlan = plan
      const next = {
        ...plan,
        vials: plan.vials.map(v =>
          v.sample_id === sampleId
            ? { ...v, assignment_role: assignRole, assignment_kind: kind }
            : v
        ),
      }
      setPlan(next)
      try {
        await patchVialAssignment(sampleId, assignRole, kind ?? undefined)
        // PATCH re-seeds/drops the vial's analyses server-side; refresh the
        // parent sample page's assignment caches so its AR overlay isn't stale.
        invalidateVialAssignmentCaches(queryClient, parentSampleId)
      } catch (e) {
        toastAssignmentError(e)
        // Roll back the optimistic update
        setPlan(prevPlan)
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
        // setError only renders when the plan failed to load — surface reset
        // failures (incl. 409 variance_locked) the same way the drag path does.
        toastAssignmentError(e)
      } finally {
        void refresh()
      }
    },
    [plan, refresh, queryClient, parentSampleId],
  )

  // vialRolesQ.isLoading is included: rendering the sections/chips before the
  // catalog resolves would let roleShort fall back to uppercased codes off a
  // cold cache (e.g. "STER" instead of "PCR") for one render, then pop to the
  // real short form — same class of flash BoxStep's own vialRolesQ gate
  // avoids. isLoading clears on either success or failure, so a catalog fetch
  // error still falls through to the fallback-labeled render, not a stall.
  if ((loading && !plan) || vialRolesQ.isLoading) {
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

  // Catalog-driven layout (spec 4, Task 9): sections is ALWAYS present, empty
  // only on the IS-unreachable path (Task 8 contract) — no local show*/gate
  // consts needed, the backend already only mints a section when a role has
  // real demand or a carried vial (parity with the old showHplc/showMicro
  // gates falls out of that inclusion rule for free).
  const sections = plan.sections ?? []

  const vialsForRole = (code: string) => ({
    core: plan.vials.filter(v => v.assignment_role === code && v.assignment_kind !== 'variance'),
    variance: plan.vials.filter(v => v.assignment_role === code && v.assignment_kind === 'variance'),
  })

  // Every role code the catalog actually placed in a section this render.
  // Xtra is the visible landing spot for anything else carrying a real role:
  // the literal 'xtra'/null vials (as before), PLUS any role code sections
  // excluded — an unregistered code (_build_vial_plan_sections logs + drops
  // it server-side) or, on the IS-unreachable path, every carried role
  // (sections: []). Never invisible — this is the hm-invisibility fix.
  const sectionRoleCodes = new Set(sections.flatMap(s => s.roles.map(r => r.code)))
  const xtraVials = plan.vials.filter(v => {
    const role = v.assignment_role
    if (role == null || role === 'xtra') return true
    return !sectionRoleCodes.has(role)
  })

  // Grid: one column per section + the always-on Xtra column (last in DOM
  // order). auto-fit collapses empty tracks so 1-2 sections still fill the
  // row instead of leaving dead space; columns wrap to new rows once the
  // viewport can't fit another 240px minimum, fixing narrow-viewport cutoff.
  const gridTemplateColumns = 'repeat(auto-fit, minmax(240px, 1fr))'

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="p-6">
        {plan.is_unreachable && (
          <div className="mb-4 p-3 rounded border border-amber-500/40 bg-amber-500/10 text-sm">
            Couldn't load order services from integration service — auto-assign skipped.
            Drag vials manually. Print still works.
          </div>
        )}
        <div className="grid gap-4" style={{ gridTemplateColumns }}>
          {sections.map(section => (
            <DepartmentSection
              key={section.department_id}
              section={section}
              plan={plan}
              vialsForRole={vialsForRole}
              onReset={handleResetBucket}
              roleShort={roleShort}
              roleColor={roleColor}
            />
          ))}
          <Bucket
            id="xtra"
            label="Xtra"
            shortLabel={roleShort('xtra')}
            vials={xtraVials}
            demand={null}
            onReset={null}
            roleShort={roleShort}
            roleColor={roleColor}
          />
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

/** Lab-side variance count override — interim until the WP variance addon ships.
 *  UNCHANGED by Task 9's catalog-driven rewrite: the three WP-key ternaries
 *  below are legacy-only by backend contract (plan.variance is fixed-shape
 *  {hplc, endo, ster} — derive_variance_demand never emits a catalog-only
 *  role), so this editor has no section/role-spot dependency to widen. */
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
              <p className="font-semibold">Variance count = total vials tested</p>
              <p>
                The number is the TOTAL vials tested from the lot. The first
                vial is part of the <span className="font-medium">core
                offering</span>, so the client pays for n&nbsp;−&nbsp;1
                replicates: HPLC&nbsp;2 = the core vial + 1 paid variance
                replicate. The paid marker on the Variance drop zone below
                shows the replicate count — it never blocks assignment.
              </p>
              <p>
                0 = no variance testing purchased. 1 is meaningless (one vial
                is just the core test) and is treated as none.
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
          otherwise the TOTAL vials tested (≥2; the first is the core vial).
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

/** Header pill flagging a bucket as carrying variance demand. */
function VariancePill({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400">
      Variance ×{n}
    </span>
  )
}

function Bucket({
  id, label, shortLabel, vials, demand, onReset, varianceN = 0, varianceVials, withVarianceZone = false, roleShort, roleColor,
}: {
  id: BucketId
  label: string
  /** Short form of `label` for the nested variance zone's "{shortLabel}
   *  Variance" header (spec 4, Task 9 — replaces the old
   *  `label === 'Analyses Dept.' ? 'HPLC' : label` ternary; catalog-driven
   *  now, via `roleShort(role.code)` at the call site). */
  shortLabel: string
  /** Core vials for this bucket (assignment_kind === 'core', or untyped for back-compat). */
  vials: VialPlanItem[]
  demand: number | null
  onReset: (() => void) | null
  /** Paid variance count: number of variance vials purchased IN ADDITION to
   *  core demand. Display-only marker — never blocks drops. */
  varianceN?: number
  /** Variance vials (assignment_kind === 'variance') — shown in the variance sub-zone. */
  varianceVials?: VialPlanItem[]
  /** Render the variance drop zone. On for every testable role bucket even at
   *  paid 0 — assignment is operational and free (internal QC replicates);
   *  entitlement is a marker only. Off for xtra. */
  withVarianceZone?: boolean
  /** S1 roles-as-data: threaded from AssignStep's single useVialRoles() call
   *  down to each DraggableVial chip this bucket (and its variance zone) renders. */
  roleShort: RoleShortFn
  /** Paired with roleShort — same threading, chip color instead of label. */
  roleColor: RoleColorFn
}) {
  const varianceBucketId = `${id}_variance` as BucketId
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
          {varianceN >= 2 && <VariancePill n={varianceN} />}
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
        {vials.length === 0 && !withVarianceZone && (
          <p className="text-xs text-muted-foreground italic">empty</p>
        )}
        {vials.map(v => <DraggableVial key={v.sample_id} vial={v} roleShort={roleShort} roleColor={roleColor} />)}
      </div>
      {withVarianceZone && (
        <VarianceDropZone
          id={varianceBucketId}
          paidCount={varianceN}
          vials={varianceVials ?? []}
          roleLabel={shortLabel}
          roleShort={roleShort}
          roleColor={roleColor}
        />
      )}
    </div>
  )
}

/** Chips for a role spot's rider profiles (spec 4, Task 8/9) — profiles that
 *  attach their result to the host's vial instead of minting their own
 *  (resolve_catalog_fulfillment). Rendered as a SIBLING beneath the spot's
 *  Bucket/SubDropZone rather than as a prop threaded into either of those
 *  kept-verbatim components — keeps both untouched. Prominent accent pill
 *  (Handler 2026-08-20 — the earlier muted 10px text was easy to miss),
 *  same pill anatomy as the variance "paid" badge; NOT a drop target —
 *  riders never mint their own role. */
function RiderChips({ profiles }: { profiles: VialPlanRoleProfile[] }) {
  const riders = profiles.filter(p => p.relation === 'rider')
  if (riders.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5 pl-3">
      {riders.map(r => {
        const landing = (r.host_vials ?? [])
          .map(v => v.split('-').pop())
          .filter(Boolean)
          .join(', ')
        return (
          <span
            key={r.id}
            title={(r.host_vials ?? []).join(', ') || undefined}
            className="inline-flex items-center gap-1 rounded-md border border-primary/45 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
          >
            <CornerDownRight className="h-3 w-3" aria-hidden="true" />
            {r.name}
            <span className="font-normal opacity-80">
              · rider{landing ? ` → ${landing}` : ''}
            </span>
          </span>
        )
      })}
    </div>
  )
}

/** Dispatches a department section to the one-role vs. many-role layout
 *  (spec 4, Task 9): a single-role department renders as a direct-drop
 *  Bucket (today's Analytical look); two-or-more renders as a Bucket-styled
 *  shell of per-role SubDropZones (today's Microbiology look). */
function DepartmentSection(props: {
  section: VialPlanSection
  plan: VialPlanResponse
  vialsForRole: (code: string) => { core: VialPlanItem[]; variance: VialPlanItem[] }
  onReset: (bucket: BucketId) => void
  roleShort: RoleShortFn
  roleColor: RoleColorFn
}) {
  const [onlyRole, ...rest] = props.section.roles
  if (onlyRole && rest.length === 0) {
    return <SingleRoleSection {...props} role={onlyRole} />
  }
  return <MultiRoleSection {...props} />
}

/** Single-role department section (spec 4, Task 9) — today's Analytical
 *  look: a direct-drop Bucket, id = the role's code. Renders the role's
 *  variance zone and rider chips through the same generic path a multi-role
 *  section uses. */
function SingleRoleSection({
  section, role, plan, vialsForRole, onReset, roleShort, roleColor,
}: {
  section: VialPlanSection
  role: VialPlanSection['roles'][number]
  plan: VialPlanResponse
  vialsForRole: (code: string) => { core: VialPlanItem[]; variance: VialPlanItem[] }
  onReset: (bucket: BucketId) => void
  roleShort: RoleShortFn
  roleColor: RoleColorFn
}) {
  const { core, variance } = vialsForRole(role.code)
  const demand = plan.demand[role.code] ?? 0
  const roleVarianceN = varianceFor(plan.variance, role.code)
  // Stored variance vials ALWAYS reveal the zone, regardless of
  // variance_eligible — the flag only gates proactively revealing an EMPTY
  // zone off the paid count. Gating the whole thing on variance_eligible
  // would make already-assigned variance vials invisible the moment an
  // admin edits that flag off — the same invisibility class this task fixed
  // for hm. See varianceFor: roleVarianceN can only be nonzero for
  // hplc/endo/ster anyway (plan.variance's fixed legacy shape), so
  // variance_eligible only ever matters as a guard on THAT branch.
  const withVarianceZone = variance.length > 0 || (role.variance_eligible && roleVarianceN > 0)
  return (
    <div>
      <Bucket
        id={role.code}
        label={section.department_name}
        shortLabel={roleShort(role.code)}
        vials={core}
        varianceVials={variance}
        demand={demand}
        varianceN={roleVarianceN}
        withVarianceZone={withVarianceZone}
        onReset={() => onReset(role.code)}
        roleShort={roleShort}
        roleColor={roleColor}
      />
      <RiderChips profiles={role.profiles} />
    </div>
  )
}

/** Multi-role department section (spec 4, Task 9) — today's Microbiology
 *  look, generalized from the deleted MicroBucket to any N-role catalog
 *  section: a Bucket-styled shell wrapping one SubDropZone (+ optional
 *  VarianceDropZone, + rider chips) per role.
 *
 *  BW-0015 constraint (moved here from the deleted MicroBucket, still load-
 *  bearing): the original bug was an always-on variance zone nested inside
 *  the core bucket — a vial dragged back toward the section could land on
 *  variance by accident, silently flipping assignment_kind with no
 *  entitlement. Fixed by rendering each VarianceDropZone conditionally
 *  (entitlement-gated: only when a paid replicate exists or the bucket
 *  already holds variance vials). Downstream of that fix, the outer shell
 *  here is deliberately NOT a useDroppable target either — an always-on
 *  drop id on the shell would reintroduce the same class of accidental
 *  landing, just one level up; only the per-role SubDropZone/
 *  VarianceDropZone below are real drop targets. */
function MultiRoleSection({
  section, plan, vialsForRole, onReset, roleShort, roleColor,
}: {
  section: VialPlanSection
  plan: VialPlanResponse
  vialsForRole: (code: string) => { core: VialPlanItem[]; variance: VialPlanItem[] }
  onReset: (bucket: BucketId) => void
  roleShort: RoleShortFn
  roleColor: RoleColorFn
}) {
  const totals = section.roles.reduce(
    (acc, r) => {
      acc.assigned += vialsForRole(r.code).core.length
      acc.demand += plan.demand[r.code] ?? 0
      return acc
    },
    { assigned: 0, demand: 0 },
  )
  const isShort = totals.assigned < totals.demand

  return (
    <div
      className={cn(
        'border-2 rounded-lg p-3 min-h-[120px]',
        totals.assigned === totals.demand && totals.demand > 0
          ? 'border-solid border-primary/45'
          : isShort
          ? 'border-dashed border-amber-500/55 bg-amber-500/5'
          : 'border-dashed border-muted-foreground/35'
      )}
    >
      <header className="flex justify-between items-baseline mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        <strong className="text-foreground font-semibold">{section.department_name}</strong>
        <span className={cn(isShort && 'text-amber-500')}>
          {totals.assigned} / {totals.demand}
        </span>
      </header>
      {section.roles.map(role => {
        const { core, variance } = vialsForRole(role.code)
        const roleDemand = plan.demand[role.code] ?? 0
        const roleVarianceN = varianceFor(plan.variance, role.code)
        // Variance zones are entitlement-gated (2026-06-16): shown when there is
        // at least one PAID variance replicate — plan.variance is the replicate
        // count (total vials − 1), so >0 means "any variance purchased" (a
        // 2-total upsell = 1 replicate). variance_eligible guards ONLY that paid-
        // count branch (belt-and-braces — plan.variance is a fixed 3-key legacy
        // dict, so only hplc/endo/ster can ever carry a nonzero count regardless
        // of what the catalog role allows); it must NOT gate stored variance
        // vials — an admin flipping the flag off must never make an
        // already-assigned variance vial invisible (the hm-invisibility class).
        const showVarianceZone = variance.length > 0 || (role.variance_eligible && roleVarianceN > 0)
        return (
          <div key={role.code}>
            <SubDropZone
              id={role.code}
              label={role.label}
              vials={core}
              demand={roleDemand}
              varianceN={roleVarianceN}
              onReset={() => onReset(role.code)}
              roleShort={roleShort}
              roleColor={roleColor}
            />
            <RiderChips profiles={role.profiles} />
            {showVarianceZone && (
              <VarianceDropZone
                id={`${role.code}_variance`}
                paidCount={roleVarianceN}
                vials={variance}
                roleLabel={roleShort(role.code)}
                roleShort={roleShort}
                roleColor={roleColor}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Droppable sub-zone for variance vials within a role bucket.
 *  Shows "HPLC Variance · paid N" header and accepts drops into `{role}_variance`. */
function VarianceDropZone({
  id, paidCount, vials, roleLabel, roleShort, roleColor,
}: {
  id: BucketId
  paidCount: number
  vials: VialPlanItem[]
  roleLabel: string
  roleShort: RoleShortFn
  roleColor: RoleColorFn
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const extraCount = Math.max(0, vials.length - paidCount)
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'pl-3 mt-2 border-l-2 transition-colors',
        isOver ? 'border-l-sky-500' : 'border-l-sky-500/30'
      )}
    >
      <div className="text-[10px] uppercase tracking-wide mb-1 flex justify-between text-sky-600 dark:text-sky-400">
        <span>
          {roleLabel} Variance
          <span className="ml-1 text-muted-foreground normal-case">· paid {paidCount}</span>
        </span>
        {extraCount > 0 && (
          <span className="text-amber-500">+{extraCount} extra</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {vials.length === 0 && (
          <p className="text-xs text-muted-foreground italic">drop here</p>
        )}
        {vials.map(v => <DraggableVial key={v.sample_id} vial={v} roleShort={roleShort} roleColor={roleColor} />)}
      </div>
    </div>
  )
}

function SubDropZone({
  id, label, vials, demand, onReset, varianceN = 0, roleShort, roleColor,
}: {
  id: BucketId
  label: string
  vials: VialPlanItem[]
  demand: number
  onReset: () => void
  varianceN?: number
  roleShort: RoleShortFn
  roleColor: RoleColorFn
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
        {vials.map(v => <DraggableVial key={v.sample_id} vial={v} roleShort={roleShort} roleColor={roleColor} />)}
      </div>
    </div>
  )
}

function DraggableVial({
  vial, roleShort, roleColor,
}: {
  vial: VialPlanItem
  roleShort: RoleShortFn
  roleColor: RoleColorFn
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: vial.sample_id,
  })
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined
  const role = vial.assignment_role ?? 'xtra'
  const chipColor = roleColor(role)
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
      <span className={cn('text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wide', chipColor)}>
        {roleShort(role)}
      </span>
    </div>
  )
}
