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
import { useEffect, useState } from 'react'
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  listSubSamples,
  listLimsAnalysesForSubSample,
  listParentLineStates,
  fetchSubSamplePhotoUrl,
} from '@/lib/api'
import type { SenaiteAnalysis, SubSample } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { AnalysisTable } from '@/components/senaite/AnalysisTable'
import {
  RoleHeaderBadge,
  computePrimaryAnalysisUids,
  patchAnalysisInList,
} from '@/components/senaite/vial-quicklook-helpers'

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
  ['quicklook-vial-analyses', subSamplePk] as const

/**
 * Vial photo thumbnail. Mirrors the private VialThumb in
 * intake/ReceiveWizard/VialsList.tsx:44 (fetchSubSamplePhotoUrl is
 * module-level cached, so repeated opens are free). Kept local — VialThumb
 * is not exported and dedup of the wizard copies is out of scope.
 */
function VialPhotoThumb({ sampleId, hasPhoto }: { sampleId: string; hasPhoto: boolean }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!hasPhoto) {
      setUrl(null)
      return
    }
    let cancelled = false
    void fetchSubSamplePhotoUrl(sampleId)
      .then(u => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [sampleId, hasPhoto])

  return (
    <div className="w-12 h-12 rounded bg-muted/60 border shrink-0 overflow-hidden flex items-center justify-center">
      {url ? (
        <img src={url} alt={`${sampleId} photo`} className="w-full h-full object-cover" />
      ) : (
        <span className="text-[8px] text-muted-foreground">no photo</span>
      )}
    </div>
  )
}

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
          {vials.map((vial, i) => (
            <VialSection
              key={vial.id}
              vial={vial}
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
  const analyses = query.data ?? []
  const primaryUids = computePrimaryAnalysisUids(analyses, vial.assignment_role)

  return (
    <div className="rounded-md border">
      <div
        data-testid="quicklook-vial-header"
        className="flex items-center gap-2 px-3 py-2 bg-muted/40"
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
        {vial.assignment_role && <RoleHeaderBadge role={vial.assignment_role} />}
        <span className="text-xs text-muted-foreground ml-auto">
          {analyses.length} {analyses.length === 1 ? 'analysis' : 'analyses'}
          {' · received '}
          {new Date(vial.received_at).toLocaleDateString()}
        </span>
      </div>
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
          ) : analyses.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              No analyses assigned
            </p>
          ) : (
            <AnalysisTable
              analyses={analyses}
              analyteNameMap={analyteNameMap}
              primaryAnalysisUids={primaryUids}
              primaryRole={vial.assignment_role}
              parentLineStates={parentLineStates}
              onResultSaved={onResultSaved}
              onMethodInstrumentSaved={onMethodInstrumentSaved}
              onTransitionComplete={onTransitionComplete}
            />
          )}
        </div>
      )}
    </div>
  )
}
