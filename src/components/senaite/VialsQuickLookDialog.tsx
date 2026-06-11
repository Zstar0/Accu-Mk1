/**
 * Vials Quick Look — a wide dialog on parent sample pages stacking every
 * vial's fully interactive AnalysisTable (same fields and behaviors as the
 * vial detail pages). Spec: docs/superpowers/specs/2026-06-05-vials-quicklook-design.md
 *
 * Data: one listSubSamples + one listParentLineStates + N parallel
 * listLimsAnalysesForSubSample (TanStack Query, enabled only while open).
 * The vial pages load analyses with local state and refetch on mount, so the
 * dialog's 'quicklook-*' query keys are private to this surface.
 */
import { useMemo, useState } from 'react'
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import {
  listSubSamples,
  listLimsAnalysesForSubSample,
  listParentLineStates,
  patchVialAssignment,
} from '@/lib/api'
import type {
  AssignmentRole,
  ParentSampleSummary,
  SenaiteAnalysis,
  SubSample,
} from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { AnalysisTable } from '@/components/senaite/AnalysisTable'
import { buildNativeSubSampleLookup } from '@/lib/native-sub-sample'
import { vialLabel, vialTotal } from '@/lib/vial-label'
import {
  invalidateVialAssignmentCaches,
  invalidateParentVialOverlay,
  QUICKLOOK_VIAL_ANALYSES_QUERY_KEY,
} from '@/lib/vial-assignment'
import { useAnalysisSlaMap } from '@/services/analysis-sla'
import {
  RoleHeaderBadge,
  VialPhotoThumb,
  computePrimaryAnalysisUids,
  patchAnalysisInList,
} from '@/components/senaite/vial-quicklook-helpers'

/** Role options for the quick re-assign dropdown — labels match SampleDetails'
 *  assignmentLabel switch (em-dashes, verbatim). `null` = Unassigned. */
const REASSIGN_OPTIONS: { label: string; role: AssignmentRole | null }[] = [
  { label: 'Analytical HPLC', role: 'hplc' },
  { label: 'Microbiology — Endotoxin', role: 'endo' },
  { label: 'Microbiology — Sterility', role: 'ster' },
  { label: 'Extra (unassigned)', role: 'xtra' },
  { label: 'Unassigned', role: null },
]

interface VialsQuickLookDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Parent sample ID, e.g. "P-0144". Only rendered on parent pages. */
  parentSampleId: string
  /** Slot number → display peptide name, computed by SampleDetails. */
  analyteNameMap: Map<number, string>
  /**
   * Called after a transition completes in any vial table. Promote/retest can
   * mutate parent-AR rows, so the parent page underneath should refresh.
   */
  onParentDataStale?: () => void
}

const vialAnalysesKey = (subSamplePk: number) =>
  [QUICKLOOK_VIAL_ANALYSES_QUERY_KEY, subSamplePk] as const

export function VialsQuickLookDialog({
  open,
  onOpenChange,
  parentSampleId,
  analyteNameMap,
  onParentDataStale,
}: VialsQuickLookDialogProps) {
  const navigateToSample = useUIStore(state => state.navigateToSample)
  const queryClient = useQueryClient()
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())

  const { data: subData, isPending: subsLoading } = useQuery({
    queryKey: ['sub-samples', parentSampleId],
    queryFn: () => listSubSamples(parentSampleId),
    enabled: open,
  })
  const vials = [...(subData?.sub_samples ?? [])].sort(
    (a, b) => a.vial_sequence - b.vial_sequence
  )

  const { data: lineStatesData, refetch: refetchLineStates } = useQuery({
    queryKey: ['quicklook-parent-line-states', parentSampleId],
    queryFn: () => listParentLineStates(parentSampleId),
    enabled: open,
  })
  const parentLineStates = lineStatesData?.states

  const analysesQueries = useQueries({
    queries: vials.map(v => ({
      queryKey: vialAnalysesKey(v.id),
      queryFn: () => listLimsAnalysesForSubSample(v.id),
      enabled: open,
    })),
  })

  const toggleCollapsed = (pk: number) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(pk)) next.delete(pk)
      else next.add(pk)
      return next
    })
  }

  const goToVial = (sampleId: string) => {
    onOpenChange(false)
    navigateToSample(sampleId)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[90vw] xl:max-w-[1400px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Vials — {parentSampleId}</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto flex-1 space-y-4 pr-1">
          {subsLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={18} className="animate-spin text-muted-foreground" />
            </div>
          ) : vials.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No vials found.
            </p>
          ) : null}
          {subData?.parent &&
            vials.map((vial, i) => (
            <VialSection
              key={vial.id}
              vial={vial}
              parent={subData.parent}
              parentSampleId={parentSampleId}
              query={analysesQueries[i]!}
              analyteNameMap={analyteNameMap}
              parentLineStates={parentLineStates}
              isCollapsed={collapsed.has(vial.id)}
              onToggleCollapsed={() => toggleCollapsed(vial.id)}
              onNavigate={() => goToVial(vial.sample_id)}
              onResultSaved={(uid, newResult, newReviewState) => {
                queryClient.setQueryData<SenaiteAnalysis[]>(
                  vialAnalysesKey(vial.id),
                  prev => prev && patchAnalysisInList(prev, uid, newResult, newReviewState)
                )
                // The parent AR overlay shows this vial's analyst + review state;
                // a result save changes both, so refresh that vial's overlay.
                invalidateParentVialOverlay(queryClient, vial.id)
              }}
              onMethodInstrumentSaved={(uid, field, newUid, newTitle) => {
                queryClient.setQueryData<SenaiteAnalysis[]>(
                  vialAnalysesKey(vial.id),
                  prev =>
                    prev?.map(a =>
                      a.uid === uid
                        ? field === 'method'
                          ? { ...a, method: newTitle, method_uid: newUid }
                          : { ...a, instrument: newTitle, instrument_uid: newUid }
                        : a
                    )
                )
                // The parent AR overlay shows this vial's method/instrument too.
                invalidateParentVialOverlay(queryClient, vial.id)
              }}
              onTransitionComplete={() => {
                queryClient.invalidateQueries({ queryKey: vialAnalysesKey(vial.id) })
                void refetchLineStates()
                onParentDataStale?.()
              }}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface VialSectionProps {
  vial: SubSample
  parent: ParentSampleSummary
  parentSampleId: string
  query: {
    data?: SenaiteAnalysis[]
    isLoading: boolean
    isError: boolean
    refetch: () => void
  }
  analyteNameMap: Map<number, string>
  parentLineStates: Record<string, string> | undefined
  isCollapsed: boolean
  onToggleCollapsed: () => void
  onNavigate: () => void
  onResultSaved: (uid: string, newResult: string, newReviewState: string | null) => void
  onMethodInstrumentSaved: (
    uid: string,
    field: 'method' | 'instrument',
    newUid: string | null,
    newTitle: string | null
  ) => void
  onTransitionComplete: () => void
}

function VialSection({
  vial,
  parent,
  parentSampleId,
  query,
  analyteNameMap,
  parentLineStates,
  isCollapsed,
  onToggleCollapsed,
  onNavigate,
  onResultSaved,
  onMethodInstrumentSaved,
  onTransitionComplete,
}: VialSectionProps) {
  const queryClient = useQueryClient()
  const [isReassigning, setIsReassigning] = useState(false)
  const analyses = query.data ?? []
  const primaryUids = computePrimaryAnalysisUids(analyses, vial.assignment_role)

  // Per-vial SLA — same code path the vial detail page uses (native-built
  // lookup + the vial's analyses), so the SLA column matches the vial page.
  const slaLookup = useMemo(
    () => ({ ...buildNativeSubSampleLookup(vial, parent), analyses }),
    [vial, parent, analyses]
  )
  const sla = useAnalysisSlaMap(slaLookup)

  const handleReassign = async (role: AssignmentRole | null) => {
    setIsReassigning(true)
    try {
      // Carry the vial's existing assignment_kind through the role change — a
      // kind-omitted PATCH clobbers kind to NULL server-side, which would
      // silently flip a variance vial onto the promote path. (Backend still
      // coerces kind to NULL for xtra/unassigned targets.)
      await patchVialAssignment(vial.sample_id, role, vial.assignment_kind ?? null)
      toast.success(`Re-assigned ${vial.sample_id}`)
      // assignment PATCH auto-seeds + drops analyses server-side; refetch every
      // surface that renders assignment state, including the parent page's AR
      // overlay underneath this dialog (not just our own quicklook queries).
      invalidateVialAssignmentCaches(queryClient, parentSampleId)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Re-assignment failed')
    } finally {
      setIsReassigning(false)
    }
  }

  // The per-vial header row. Used both as AnalysisTable's headerContent (when
  // expanded with analyses, so the table's own Card becomes the section) and as
  // the slim header for the collapsed/loading/error/empty states. Always carries
  // data-testid="quicklook-vial-header" so tests find one header per vial.
  const vialHeader = (
    <div
      data-testid="quicklook-vial-header"
      className="flex items-center gap-2 flex-wrap min-w-0"
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0"
        aria-label={isCollapsed ? 'Expand vial' : 'Collapse vial'}
        onClick={onToggleCollapsed}
      >
        {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </Button>
      <VialPhotoThumb
        sampleId={vial.sample_id}
        hasPhoto={!!vial.photo_external_uid}
      />
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 font-mono text-sm"
        onClick={onNavigate}
      >
        {vial.sample_id}
      </Button>
      <span className="text-xs text-muted-foreground">
        {/* Family-indexed: parent is vial 1, so seq+1 of count+1 (matches the
            SampleDetails header convention). */}
        {vialLabel(vial.vial_sequence, parent.container_mode ?? false)} of {vialTotal(parent.sub_sample_count, parent.container_mode ?? false)}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-auto gap-1 px-1.5 py-0.5"
            title="Re-assign vial"
            aria-label="Re-assign vial"
            disabled={isReassigning}
          >
            {vial.assignment_role ? (
              <RoleHeaderBadge role={vial.assignment_role} />
            ) : (
              <span className="inline-block text-[10px] leading-none px-1.5 py-0.5 rounded border uppercase tracking-wide font-medium bg-zinc-500/15 text-zinc-700 border-zinc-500/40 dark:text-zinc-300">
                Unassigned
              </span>
            )}
            <ChevronDown size={12} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {REASSIGN_OPTIONS.map(opt => (
            <DropdownMenuItem
              key={opt.label}
              onSelect={() => void handleReassign(opt.role)}
            >
              {opt.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* ml-auto right-pins this in the slim (collapsed/loading/error/empty)
          wrapper, where the header row spans full width. Inside AnalysisTable's
          justify-between header the left block is content-sized, so it's a
          no-op there. */}
      <span className="text-xs text-muted-foreground ml-auto">
        {analyses.length} {analyses.length === 1 ? 'analysis' : 'analyses'}
        {' · received '}
        {new Date(vial.received_at).toLocaleDateString()}
      </span>
    </div>
  )

  // Expanded with analyses: fold the header into AnalysisTable's own Card so
  // there's ONE section per vial (no double-wrapping border + table Card).
  if (!isCollapsed && !query.isLoading && !query.isError && analyses.length > 0) {
    return (
      <AnalysisTable
        analyses={analyses}
        analyteNameMap={analyteNameMap}
        primaryAnalysisUids={primaryUids}
        primaryRole={vial.assignment_role}
        parentLineStates={parentLineStates}
        analysisSlaMap={sla.byKeyword}
        isAnalysisSlaLoading={sla.isLoading}
        isAnalysisSlaError={sla.isError}
        isAnalysisSlaPublished={sla.isPublished}
        analysisSlaPriority={sla.priority}
        headerContent={vialHeader}
        hideProgress
        onResultSaved={onResultSaved}
        onMethodInstrumentSaved={onMethodInstrumentSaved}
        onTransitionComplete={onTransitionComplete}
        vialKind={vial.assignment_kind}
      />
    )
  }

  // Collapsed / loading / error / empty: slim wrapper keeps the header visible
  // and toggleable without mounting the table.
  return (
    <div className="rounded-md border">
      <div className="px-3 py-2 bg-muted/40">{vialHeader}</div>
      {!isCollapsed && (
        <div className="p-2">
          {query.isLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
            </div>
          ) : query.isError ? (
            <div className="flex items-center gap-3 px-2 py-3 text-sm text-destructive">
              Failed to load analyses for this vial.
              <Button variant="outline" size="sm" onClick={() => query.refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              No analyses assigned
            </p>
          )}
        </div>
      )}
    </div>
  )
}
