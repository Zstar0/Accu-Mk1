import { useState, useEffect, useId, useRef, useMemo, useCallback } from 'react'
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import { InternalRemarkCard } from '@/components/senaite/InternalRemarkCard'
import { useTheme } from '@/hooks/use-theme'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Package,
  Hash,
  Info,
  Layers,
  Shield,
  ShieldCheck,
  MessageSquare,
  Activity,
  ExternalLink,
  Loader2,
  X,
  XCircle,
  ArrowLeft,
  Box,
  RefreshCw,
  Copy,
  Paperclip,
  ImageIcon,
  Upload,
  Maximize2,
  FileText,
  Terminal,
  CornerDownRight,
  Radar,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import {
  lookupSenaiteSample,
  updateSenaiteSampleFields,
  updateCustomerRemarks,
  getSampleAdditionalCOAs,
  updateAdditionalCOAConfig,
  fetchSenaiteAttachmentUrl,
  fetchSenaiteAttachmentText,
  uploadSenaiteAttachment,
  fetchSenaiteReportUrl,
  getExplorerCOAGenerations,
  getExplorerCOASignedUrl,
  generateSenaiteCOA,
  generateVialCOAs,
  publishSenaiteCOA,
  regenPrimaryCOA,
  regenAdditionalCOA,
  listSamplePreps,
  listAnalysisServices,
  addAnalysisToSample,
  removeAnalysisFromSample,
  getRemovalImpact,
  type RemovalImpact,
  getPeptides,
  getSampleAnalyteAliases,
  setSampleAnalyteAlias,
  clearSampleAnalyteAlias,
  type SenaiteLookupResult,
  type SenaiteAttachment,
  type SenaiteAttachmentType,
  type SenaitePublishedCOA,
  type AdditionalCOAConfig,
  type ExplorerCOAGeneration,
  type WooOrder,
  type SamplePrep,
  type HplcScanMatch,
  type AnalysisService,
  type PeptideRecord,
  getWooOrder,
  fetchChromatogramLttb,
  listSubSamples,
  getVarianceSet,
  listLimsAnalysesForSubSample,
  listParentPromotions,
  listParentLineStates,
  type ParentPromotionInfo,
  fetchSubSamplePhotoUrl,
  invalidateSubSamplePhoto,
  seedSubSamplePhoto,
  deleteSubSamplePhoto,
  updateSubSample,
  type SubSample,
  listSubSampleAttachments,
  uploadSubSampleAttachment,
  fetchSubSampleAttachmentUrl,
  deleteSubSampleAttachment,
  setSubSamplePrimaryAttachment,
  type SubSampleAttachment,
  listWorksheets,
  getExplorerOrderById,
  getSenaiteSamples,
  listSubSampleChromatograms,
  uploadChromatogramToSenaite,
  type SubSampleChromatogram,
  listPackagingPhotos,
  fetchPackagingPhotoUrl,
  type PackagingPhoto,
} from '@/lib/api'
import { ReceiveWizard } from '@/components/intake/ReceiveWizard/ReceiveWizard'
import type { ParentInfo } from '@/components/intake/ReceiveWizard/useReceiveWizard'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import {
  parseChromatogramCsv,
  downsampleLTTB,
} from '@/components/hplc/ChromatogramChart'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { useUIStore } from '@/store/ui-store'
import { findWorksheetForSample } from '@/components/hplc/worksheet-sample-filter'
import { useWizardStore } from '@/store/wizard-store'
import { getSenaiteUrl, getWordpressUrl } from '@/lib/api-profiles'
import { cn } from '@/lib/utils'
import { EditableDataRow } from '@/components/dashboard/EditableField'
import {
  AnalysisTable,
  StatusBadge,
  formatAnalysisTitle,
} from '@/components/senaite/AnalysisTable'
import { RemovalConfirmModal } from '@/components/senaite/RemovalConfirmModal'
import { ReplaceAnalyteDialog } from '@/components/senaite/ReplaceAnalyteDialog'
import { isHplcAnalyteService } from '@/lib/hplc-analyte-services'
import { needsMk1AnalysesSwap } from '@/lib/mk1-analyses-swap'
import { buildNativeSubSampleLookup } from '@/lib/native-sub-sample'
import { useReadSource } from '@/lib/read-source'
import {
  buildVialAssignmentMap,
  PARENT_OVERLAY_QUERY_KEY,
  invalidateParentVialOverlay,
} from '@/lib/vial-assignment'
import { vialLabel, vialPosition, vialTotal } from '@/lib/vial-label'
import { SampleHeaderSla } from '@/components/senaite/SampleHeaderSla'
import { useAnalysisSlaMap } from '@/services/analysis-sla'
import { SamplePrepHplcFlyout } from '@/components/hplc/SamplePrepHplcFlyout'
import { SampleActivityLog } from '@/components/senaite/SampleActivityLog'
import { SampleRegistryDebug } from '@/components/senaite/SampleRegistryDebug'
import { ReadSourceBanner } from '@/components/senaite/ReadSourceBanner'
import {
  OrderedProducts,
  useOrderedProducts,
} from '@/components/senaite/OrderedProducts'
import { ProductChip } from '@/components/senaite/ProductChip'
import {
  computeProductCompletion,
  type ProductCompletionContext,
} from '@/lib/product-completion'
import { VialsQuickLookDialog } from '@/components/senaite/VialsQuickLookDialog'
import { EntityFlagButton } from '@/components/flags/EntityFlagButton'
import { useRegisterActiveFlagEntity } from '@/components/flags/use-active-flag-entity'
import { useAuthStore } from '@/store/auth-store'
import {
  Eye,
  Microscope,
  Plus,
  Printer,
  Search,
  Star,
  Trash2,
  ScrollText,
  Sigma,
} from 'lucide-react'
import { VarianceSummary } from '@/components/samples/VarianceSummary'
import { usePrintLabel } from '@/components/samples/usePrintLabel'
import { PrintLabelPortal } from '@/components/samples/PrintLabelPortal'
import {
  RoleHeaderBadge,
  VialPhotoThumb,
  computePrimaryAnalysisUids,
} from '@/components/senaite/vial-quicklook-helpers'

// Shared between the parent-overlay useQueries fan-out and its invalidate call —
// they must stay identical or the post-edit refetch silently no-ops. Sourced
// from lib/vial-assignment so the role-change invalidate helper can't drift.
const VIAL_OVERLAY_QUERY_KEY = PARENT_OVERLAY_QUERY_KEY

// --- COA Console ---

type StepStatus = 'waiting' | 'running' | 'ok' | 'error'

interface ConsoleStep {
  id: string
  label: string
  status: StepStatus
}

interface COAConsoleState {
  visible: boolean
  title: string
  steps: ConsoleStep[]
  phase: 'running' | 'done' | 'error'
  errorDetail?: string
}

interface StepDef {
  id: string
  label: string
  /** ms from operation start when this step begins "running" */
  delay: number
}

/**
 * Map a backend error message to the step ID that most likely caused it.
 * Returns the step index, or -1 if no match (fall through to running-step logic).
 */
function inferErrorStepIdx(
  errorDetail: string | undefined,
  steps: ConsoleStep[]
): number {
  if (!errorDetail) return -1
  const msg = errorDetail.toLowerCase()
  const find = (id: string) => steps.findIndex(s => s.id === id)

  // generate-coa: COABuilder failures
  if (
    msg.includes('coa builder') ||
    msg.includes('coabuilder') ||
    msg.includes('coa generation failed')
  ) {
    const i = find('coabuilder')
    if (i >= 0) return i
  }
  // generate-coa: S3 upload failures
  if (msg.includes('s3') || msg.includes('upload failed')) {
    const i = find('s3')
    if (i >= 0) return i
  }
  // generate-coa / publish: SENAITE attach or transition failures
  if (
    msg.includes('senaite transition') ||
    msg.includes('transition failed') ||
    msg.includes('attach')
  ) {
    const i = find('senaite_tx') >= 0 ? find('senaite_tx') : find('attach')
    if (i >= 0) return i
  }
  // publish: SENAITE unreachable (first step the backend checks)
  if (msg.includes('senaite unreachable')) {
    // Maps to the SENAITE transition step since that's the SENAITE-touching step in publish
    const i = find('senaite_tx') >= 0 ? find('senaite_tx') : find('senaite')
    if (i >= 0) return i
  }
  // publish: Integration Service down
  if (msg.includes('integration service')) {
    const i = find('primary') >= 0 ? find('primary') : find('draft')
    if (i >= 0) return i
  }
  // publish: WordPress notification failure
  if (
    msg.includes('wordpress') ||
    msg.includes('wp-') ||
    msg.includes('notify')
  ) {
    const i = find('wordpress')
    if (i >= 0) return i
  }

  return -1
}

const GENERATE_STEPS: StepDef[] = [
  { id: 'senaite', label: 'Connecting to SENAITE', delay: 0 },
  { id: 'coabuilder', label: 'Running COABuilder', delay: 700 },
  { id: 'verification', label: 'Reserving verification code', delay: 3800 },
  { id: 's3', label: 'Uploading PDF to S3', delay: 4800 },
  { id: 'attach', label: 'Attaching to SENAITE', delay: 6200 },
]

const PUBLISH_STEPS: StepDef[] = [
  { id: 'draft', label: 'Locating draft generation', delay: 0 },
  { id: 'primary', label: 'Publishing primary COA', delay: 500 },
  { id: 'additional', label: 'Publishing additional COAs', delay: 1600 },
  { id: 'wordpress', label: 'Notifying WordPress', delay: 2700 },
  { id: 'senaite_tx', label: 'SENAITE transition', delay: 3700 },
]

function COAConsole({
  state,
  onClose,
}: {
  state: COAConsoleState
  onClose: () => void
}) {
  const [dotFrame, setDotFrame] = useState(0)

  useEffect(() => {
    if (state.phase !== 'running') return
    const id = setInterval(() => setDotFrame(f => (f + 1) % 5), 280)
    return () => clearInterval(id)
  }, [state.phase])

  if (!state.visible) return null

  const dots = ['·', '··', '···', '····', '·····'][dotFrame]

  return (
    <div className="absolute right-0 top-full mt-2 z-50 w-[400px] rounded-lg overflow-hidden border border-zinc-800/80 shadow-2xl shadow-black/90 select-none">
      {/* Title bar */}
      <div className="bg-zinc-900 border-b border-zinc-800/80 px-3 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex gap-1.5 shrink-0">
            <div
              className={cn(
                'w-2.5 h-2.5 rounded-full transition-colors',
                state.phase === 'error' ? 'bg-red-500' : 'bg-zinc-700'
              )}
            />
            <div
              className={cn(
                'w-2.5 h-2.5 rounded-full transition-colors',
                state.phase === 'running'
                  ? 'bg-amber-500/70 animate-pulse'
                  : 'bg-zinc-700'
              )}
            />
            <div
              className={cn(
                'w-2.5 h-2.5 rounded-full transition-colors',
                state.phase === 'done' ? 'bg-emerald-500' : 'bg-zinc-700'
              )}
            />
          </div>
          <span className="text-[11px] text-zinc-500 font-mono truncate">
            <span className="text-zinc-600">$</span> accumark {state.title}
          </span>
        </div>
        {state.phase !== 'running' && (
          <button
            onClick={onClose}
            className="shrink-0 text-zinc-600 hover:text-zinc-300 transition-colors text-[11px] font-mono leading-none"
          >
            ✕
          </button>
        )}
      </div>

      {/* Steps */}
      <div className="bg-[#0d0d0d] px-3 py-3 space-y-2">
        {state.steps.map(step => (
          <div
            key={step.id}
            className="flex items-center gap-2 font-mono text-[11px] leading-tight"
          >
            {/* Gutter icon */}
            <span
              className={cn('shrink-0 w-3 text-center', {
                'text-zinc-700': step.status === 'waiting',
                'text-amber-400': step.status === 'running',
                'text-emerald-500': step.status === 'ok',
                'text-red-500': step.status === 'error',
              })}
            >
              {step.status === 'waiting'
                ? '·'
                : step.status === 'running'
                  ? '▶'
                  : step.status === 'ok'
                    ? '✓'
                    : '✗'}
            </span>
            {/* Label */}
            <span
              className={cn({
                'text-zinc-700': step.status === 'waiting',
                'text-zinc-100': step.status === 'running',
                'text-zinc-500': step.status === 'ok',
                'text-red-400': step.status === 'error',
              })}
            >
              {step.label}
            </span>
            {/* Dot fill */}
            {step.status !== 'waiting' && (
              <span className="flex-1 overflow-hidden whitespace-nowrap text-zinc-800">
                {'·'.repeat(80)}
              </span>
            )}
            {/* Status text */}
            {step.status === 'running' && (
              <span className="shrink-0 text-amber-400/80 w-12 text-right">
                {dots}
              </span>
            )}
            {step.status === 'ok' && (
              <span className="shrink-0 text-emerald-500 font-bold w-12 text-right">
                OK
              </span>
            )}
            {step.status === 'error' && (
              <span className="shrink-0 text-red-400 font-bold w-12 text-right">
                ERR
              </span>
            )}
          </div>
        ))}

        {/* Footer */}
        <div className="pt-2 mt-1 border-t border-zinc-900 font-mono text-[10px]">
          {state.phase === 'running' && (
            <span className="text-amber-400/50">processing{dots}</span>
          )}
          {state.phase === 'done' && (
            <span className="text-emerald-500/70">
              ✓ completed successfully
            </span>
          )}
          {state.phase === 'error' && (
            <span className="text-red-400/70 whitespace-pre-line">
              ✗ {state.errorDetail ?? 'operation failed'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// --- Local helpers ---

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * Select root (primary) COA generations — those with no parent generation —
 * sorted newest first. Used as a fallback for the "Generated COAs" card when
 * SENAITE has no attached ARReport (e.g. dev stacks lacking the prod-only
 * @@accumark-attach-coa addon).
 */
export function selectRootGenerations(
  gens: ExplorerCOAGeneration[]
): ExplorerCOAGeneration[] {
  return gens
    .filter(g => g.parent_generation_id == null)
    .sort((a, b) => {
      const ta = new Date(a.created_at).getTime()
      const tb = new Date(b.created_at).getTime()
      if (tb !== ta) return tb - ta
      return b.generation_number - a.generation_number
    })
}

/**
 * Select the current per-vial COA for each HPLC vial, sorted by vial number —
 * one row per vial, mirroring how the primary card shows only the current cert.
 * Each is a child of the parent primary generation. Superseded generations are
 * excluded (so a regen+republish doesn't linger); for a vial with more than one
 * live generation (e.g. an orphan draft beside the published one), the published
 * generation wins, otherwise the latest by generation_number.
 */
export function selectVialGenerations(
  gens: ExplorerCOAGeneration[]
): ExplorerCOAGeneration[] {
  const byVial = new Map<number, ExplorerCOAGeneration>()
  for (const g of gens) {
    if (g.vial_sequence == null || g.status === 'superseded') continue
    const cur = byVial.get(g.vial_sequence)
    if (!cur) {
      byVial.set(g.vial_sequence, g)
      continue
    }
    // Prefer published over draft; among the same status, prefer the newer generation.
    const gWins =
      g.status === 'published' && cur.status !== 'published'
        ? true
        : g.status !== 'published' && cur.status === 'published'
          ? false
          : g.generation_number > cur.generation_number
    if (gWins) byVial.set(g.vial_sequence, g)
  }
  return [...byVial.values()].sort(
    (a, b) => (a.vial_sequence ?? 0) - (b.vial_sequence ?? 0)
  )
}

/**
 * Select the current regular parent-services COA — the child generated alongside
 * a variance primary (is_regular_coa). One row; superseded excluded; published
 * preferred over draft, else the latest by generation_number. Empty for a
 * non-variance sample (no regular child) — and the root/vial selectors already
 * collapse it out of their cards (it has a parent and no vial_sequence).
 */
export function selectRegularGenerations(
  gens: ExplorerCOAGeneration[]
): ExplorerCOAGeneration[] {
  let cur: ExplorerCOAGeneration | null = null
  for (const g of gens) {
    if (!g.is_regular_coa || g.status === 'superseded') continue
    if (!cur) {
      cur = g
      continue
    }
    const gWins =
      g.status === 'published' && cur.status !== 'published'
        ? true
        : g.status !== 'published' && cur.status === 'published'
          ? false
          : g.generation_number > cur.generation_number
    if (gWins) cur = g
  }
  return cur ? [cur] : []
}

/** Derive a human-readable release status from the generation + ingestion records. */
function coaReleaseStatus(gen: ExplorerCOAGeneration | null | undefined): {
  label: string
  color: 'amber' | 'emerald' | 'red' | 'zinc'
  title: string
} {
  if (!gen)
    return {
      label: 'Generated',
      color: 'amber',
      title: 'COA saved to SENAITE — not yet published',
    }
  if (gen.status === 'draft')
    return {
      label: 'Generated',
      color: 'amber',
      title: 'COA saved to SENAITE — not yet published',
    }
  if (gen.status === 'superseded')
    return {
      label: 'Superseded',
      color: 'zinc',
      title: 'Replaced by a newer generation',
    }
  // status === 'published' — check WP delivery
  if (gen.ingestion_status === 'notified')
    return {
      label: 'Published',
      color: 'emerald',
      title: 'Customer notified via WordPress',
    }
  if (gen.ingestion_status === 'partial')
    return {
      label: 'Published (WP failed)',
      color: 'red',
      title: 'Published in system but WordPress notification failed',
    }
  if (gen.ingestion_status === 'uploaded')
    return {
      label: 'Published (pending notify)',
      color: 'amber',
      title: 'PDF uploaded — WordPress notification pending',
    }
  // published with no ingestion record (desktop flow without WP order)
  return { label: 'Published', color: 'emerald', title: 'Published in system' }
}

/** PDF button for a generation row — opens the IS signed URL for that COA's PDF. */
function GeneratedCOAPdfButton({
  sampleId,
  generationNumber,
}: {
  sampleId: string
  generationNumber: number
}) {
  const [downloading, setDownloading] = useState(false)
  return (
    <button
      onClick={async () => {
        setDownloading(true)
        try {
          const { url } = await getExplorerCOASignedUrl(
            sampleId,
            generationNumber
          )
          window.open(url, '_blank')
        } catch {
          toast.error('Failed to open COA PDF')
        } finally {
          setDownloading(false)
        }
      }}
      disabled={downloading}
      className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50 cursor-pointer"
    >
      {downloading ? (
        <Loader2 size={11} className="animate-spin" />
      ) : (
        <ExternalLink size={11} />
      )}
      PDF
    </button>
  )
}

/**
 * Fallback list for the "Generated COAs" card when SENAITE has no attached
 * ARReport (data.published_coa is null) but Integration Service has root
 * generations. Also powers the "Core COA" card. Mirrors the visual language
 * of PublishedCOACard / the Additional COAs section; each row links to its COA
 * PDF via the IS signed URL.
 */
function GeneratedCOAFallbackList({
  generations,
  sampleId,
}: {
  generations: ExplorerCOAGeneration[]
  sampleId: string
}) {
  const allDraft = generations.every(g => g.status === 'draft')
  return (
    <div className="space-y-2">
      {generations.map(gen => {
        const release = coaReleaseStatus(gen)
        return (
          <div
            key={gen.id}
            className="flex items-start gap-3 p-3 rounded-lg bg-muted/40 border border-border/40"
          >
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-red-500/10 border border-red-500/20 shrink-0 mt-0.5">
              <FileText size={16} className="text-red-500 dark:text-red-400" />
            </div>
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium truncate">
                    Generation #{gen.generation_number}
                  </span>
                  <span
                    title={release.title}
                    className={cn(
                      'shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full border',
                      {
                        'bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400':
                          release.color === 'amber',
                        'bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400':
                          release.color === 'emerald',
                        'bg-red-500/10 text-red-500 border-red-500/30':
                          release.color === 'red',
                        'bg-muted text-muted-foreground border-border/40':
                          release.color === 'zinc',
                      }
                    )}
                  >
                    {release.label}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {release.color === 'emerald' && gen.verification_code && (
                    <a
                      href={accuverifyUrl(gen.verification_code)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                    >
                      View Digital COA
                    </a>
                  )}
                  <GeneratedCOAPdfButton
                    sampleId={sampleId}
                    generationNumber={gen.generation_number}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                <div className="flex flex-col">
                  <span className="text-[11px] text-muted-foreground">
                    {gen.published_at ? 'Published' : 'Created'}
                  </span>
                  <span className="text-[11px] text-foreground">
                    {formatDate(gen.published_at || gen.created_at)}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[11px] text-muted-foreground">
                    Verification Code
                  </span>
                  {gen.verification_code ? (
                    <a
                      href={accuverifyUrl(gen.verification_code)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] font-mono text-foreground hover:underline truncate"
                    >
                      {gen.verification_code}
                    </a>
                  ) : (
                    <span className="text-[11px] font-mono text-muted-foreground">
                      —
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      })}
      {allDraft && (
        <p className="text-[11px] text-muted-foreground pl-1">
          Not yet attached to SENAITE
        </p>
      )}
    </div>
  )
}

/**
 * List of per-vial COA children for the "Per-Vial COAs" card. Each row reports
 * one HPLC vial's own figure ("Vial N"), with its own verification code and
 * release status. Mirrors GeneratedCOAFallbackList's visual language.
 */
function VialCOAList({
  generations,
}: {
  generations: ExplorerCOAGeneration[]
}) {
  return (
    <div className="space-y-2">
      {generations.map(gen => {
        const release = coaReleaseStatus(gen)
        return (
          <div
            key={gen.id}
            className="flex items-start gap-3 p-3 rounded-lg bg-muted/40 border border-border/40"
          >
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-muted text-muted-foreground border border-border/40 shrink-0 mt-0.5">
              <FileText size={16} />
            </div>
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-medium truncate">
                  Vial {gen.vial_sequence}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  Gen #{gen.generation_number}
                </span>
                <span
                  title={release.title}
                  className={cn(
                    'shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full border',
                    {
                      'bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400':
                        release.color === 'amber',
                      'bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400':
                        release.color === 'emerald',
                      'bg-red-500/10 text-red-500 border-red-500/30':
                        release.color === 'red',
                      'bg-muted text-muted-foreground border-border/40':
                        release.color === 'zinc',
                    }
                  )}
                >
                  {release.label}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                <div className="flex flex-col">
                  <span className="text-[11px] text-muted-foreground">
                    Verification Code
                  </span>
                  {gen.verification_code ? (
                    <a
                      href={accuverifyUrl(gen.verification_code)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] font-mono text-foreground hover:underline truncate"
                    >
                      {gen.verification_code}
                    </a>
                  ) : (
                    <span className="text-[11px] font-mono text-muted-foreground">
                      —
                    </span>
                  )}
                </div>
                <div className="flex flex-col">
                  <span className="text-[11px] text-muted-foreground">
                    Created
                  </span>
                  <span className="text-[11px] text-foreground">
                    {formatDate(gen.created_at)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function PublishedCOACard({
  coa,
  sampleId,
  verificationCode,
  generation,
  onRefresh,
}: {
  coa: SenaitePublishedCOA
  sampleId: string
  verificationCode: string | null | undefined
  generation: ExplorerCOAGeneration | null | undefined
  onRefresh: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const release = coaReleaseStatus(generation)

  const handleRegen = async () => {
    const confirmed = window.confirm(
      `Regenerate & republish the primary COA for ${sampleId}?\n\n` +
        `This mints a NEW verification code for the primary.\n` +
        `Additional COAs keep their existing codes (untouched).`
    )
    if (!confirmed) return
    setRegenerating(true)
    try {
      const result = await regenPrimaryCOA(sampleId)
      if (result.success) {
        toast.success('Primary COA regenerated & republished', {
          description: result.verification_code
            ? `New code: ${result.verification_code}`
            : undefined,
        })
        onRefresh()
      } else {
        toast.error('Regen failed', { description: result.message })
      }
    } catch (err) {
      toast.error('Regen failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setRegenerating(false)
    }
  }

  const handleOpen = async () => {
    setLoading(true)
    try {
      const url = await fetchSenaiteReportUrl(coa.report_uid)
      window.open(url, '_blank')
      // Revoke after enough time for the new tab to read the blob
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      // toast already shown by api layer
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/40 border border-border/40">
      <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-red-500/10 border border-red-500/20 shrink-0 mt-0.5">
        <FileText size={16} className="text-red-500 dark:text-red-400" />
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium truncate">{sampleId} COA</span>
            <span
              title={release.title}
              className={cn(
                'shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full border',
                {
                  'bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400':
                    release.color === 'amber',
                  'bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400':
                    release.color === 'emerald',
                  'bg-red-500/10 text-red-500 border-red-500/30':
                    release.color === 'red',
                  'bg-muted text-muted-foreground border-border/40':
                    release.color === 'zinc',
                }
              )}
            >
              {release.label}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {release.color === 'emerald' && verificationCode && (
              <a
                href={accuverifyUrl(verificationCode)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
              >
                View Digital COA
              </a>
            )}
            <button
              onClick={handleOpen}
              disabled={loading}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50 cursor-pointer"
            >
              {loading ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <ExternalLink size={11} />
              )}
              PDF
            </button>
            <button
              onClick={handleRegen}
              disabled={regenerating}
              title="Regenerate & republish the primary COA. Mints a new verification code. Does NOT touch additional COAs."
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 transition-colors disabled:opacity-50 cursor-pointer dark:text-amber-400"
            >
              {regenerating ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <RefreshCw size={11} />
              )}
              Regen & Republish
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {coa.published_date && (
            <>
              <span className="text-[11px] text-muted-foreground">
                Published
              </span>
              <span className="text-[11px]">
                {formatDate(coa.published_date)}
              </span>
            </>
          )}
          {coa.published_by && (
            <>
              <span className="text-[11px] text-muted-foreground">
                Published by
              </span>
              <span className="text-[11px]">{coa.published_by}</span>
            </>
          )}
          <span className="text-[11px] text-muted-foreground">File size</span>
          <span className="text-[11px]">
            {formatFileSize(coa.file_size_bytes)}
          </span>
          <span className="text-[11px] text-muted-foreground">
            Verification Code
          </span>
          <div className="flex items-center gap-1">
            {verificationCode ? (
              <>
                <a
                  href={accuverifyUrl(verificationCode)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-mono text-foreground hover:underline"
                >
                  {verificationCode}
                </a>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(verificationCode)
                    toast.success('Verification code copied')
                  }}
                  className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors cursor-pointer"
                  aria-label="Copy verification code"
                >
                  <Copy size={11} />
                </button>
              </>
            ) : (
              <>
                <span className="text-[11px] text-muted-foreground">—</span>
                <button
                  onClick={onRefresh}
                  className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors cursor-pointer"
                  aria-label="Refresh from SENAITE"
                  title="Check if verification code has been set"
                >
                  <RefreshCw size={11} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function AttachmentImage({ attachment }: { attachment: SenaiteAttachment }) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!attachment.download_url) {
      setError(true)
      setLoading(false)
      return
    }
    let cancelled = false
    fetchSenaiteAttachmentUrl(attachment.uid)
      .then(url => {
        if (!cancelled) setSrc(url)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [attachment.uid, attachment.download_url])

  if (loading) {
    return (
      <div className="flex items-center justify-center w-full h-48 rounded-lg bg-muted/40 border border-border/30">
        <Spinner className="size-5" />
      </div>
    )
  }

  if (error || !src) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 w-full h-48 rounded-lg bg-muted/40 border border-border/30">
        <ImageIcon size={24} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          Failed to load image
        </span>
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={attachment.filename}
      className="rounded-lg border border-border/30 max-h-40 w-auto object-contain"
    />
  )
}

// ── Packaging photos (Mk1) — read-only thumbnails in Attachments ─────────────
// Parent-sample packaging photos captured during check-in / the Manage
// Sub-Samples overlay. This surface is READ-ONLY: all mutation (add/retake/
// remove) happens in the wizard. The ['packaging-photos', parentSampleId]
// query key is shared with the wizard so caches stay in sync.

/** Single packaging photo thumbnail. Mirrors AttachmentImage's blob-backed
 *  load/loading/error states. No controls — read-only. Bytes come through
 *  react-query so the wizard's retake path (which PATCHes the SAME photo id
 *  and invalidates ['packaging-photo-bytes', id]) refreshes this thumbnail. */
function PackagingThumb({ photo }: { photo: PackagingPhoto }) {
  const { data: src = null, isPending: loading, isError: error } = useQuery({
    queryKey: ['packaging-photo-bytes', photo.id],
    queryFn: () => fetchPackagingPhotoUrl(photo.id),
  })

  return (
    <div className="space-y-1.5">
      {loading ? (
        <div className="flex items-center justify-center w-full h-48 rounded-lg bg-muted/40 border border-border/30">
          <Spinner className="size-5" />
        </div>
      ) : error || !src ? (
        <div className="flex flex-col items-center justify-center gap-2 w-full h-48 rounded-lg bg-muted/40 border border-border/30">
          <ImageIcon size={24} className="text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Failed to load image</span>
        </div>
      ) : (
        <img
          src={src}
          alt={photo.remarks ?? 'Packaging photo'}
          className="rounded-lg border border-border/30 max-h-40 w-auto object-contain"
        />
      )}
      {photo.remarks && (
        <p className="text-xs text-muted-foreground">{photo.remarks}</p>
      )}
    </div>
  )
}

/** Read-only "Packaging" group for the Attachments section. Renders nothing
 *  when the parent sample has no packaging photos. Exported for isolated
 *  testing (SampleDetails is too heavy to render whole in a unit test). */
export function PackagingAttachmentsGroup({ parentSampleId }: { parentSampleId: string }) {
  const { data: photos } = useQuery({
    queryKey: ['packaging-photos', parentSampleId],
    queryFn: () => listPackagingPhotos(parentSampleId),
    enabled: !!parentSampleId,
  })

  if (!photos || photos.length === 0) return null

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Packaging</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {photos.map(photo => (
          <PackagingThumb key={photo.id} photo={photo} />
        ))}
      </div>
    </div>
  )
}

const CHART_SLATE = '#94a3b8'
const CHART_GRID = '#334155'
const CHART_BLUE = '#60a5fa'

function HplcAttachmentChart({
  attachment,
}: {
  attachment: SenaiteAttachment
}) {
  const [chartData, setChartData] = useState<{ t: number; v: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchSenaiteAttachmentText(attachment.uid)
      .then(text => {
        if (cancelled) return
        const raw = parseChromatogramCsv(text)
        const pts = downsampleLTTB(raw, 800)
        if (pts.length > 0) {
          setChartData(pts.map(([t, v]) => ({ t, v })))
        } else {
          setError(true)
        }
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [attachment.uid])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-52 rounded-lg bg-muted/40 border border-border/30">
        <Spinner className="size-5" />
      </div>
    )
  }
  if (error || chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-52 rounded-lg bg-muted/40 border border-border/30">
        <span className="text-xs text-muted-foreground">
          Failed to parse chromatogram
        </span>
      </div>
    )
  }

  const chartInner = (tall: boolean) => (
    <LineChart
      data={chartData}
      margin={{ top: 8, right: 16, bottom: 20, left: tall ? 8 : 4 }}
    >
      <CartesianGrid
        strokeDasharray="3 3"
        stroke={CHART_GRID}
        vertical={false}
      />
      <XAxis
        dataKey="t"
        type="number"
        domain={['dataMin', 'dataMax']}
        tick={{ fontSize: tall ? 11 : 9, fill: CHART_SLATE }}
        axisLine={{ stroke: CHART_GRID }}
        tickLine={false}
        tickFormatter={(v: number) => v.toFixed(1)}
        label={{
          value: 'min',
          position: 'insideBottom',
          offset: -10,
          style: { fontSize: tall ? 11 : 9, fill: CHART_SLATE },
        }}
      />
      <YAxis
        tick={{ fontSize: tall ? 11 : 9, fill: CHART_SLATE }}
        axisLine={false}
        tickLine={false}
        tickFormatter={(v: number) =>
          v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(Math.round(v))
        }
        width={tall ? 48 : 40}
      />
      <Tooltip
        contentStyle={{
          backgroundColor: '#1e293b',
          border: '1px solid #475569',
          borderRadius: 6,
          fontSize: tall ? 12 : 10,
        }}
        labelStyle={{ color: CHART_SLATE }}
        itemStyle={{ color: '#e2e8f0' }}
        labelFormatter={v => `${Number(v).toFixed(3)} min`}
        formatter={value => [Number(value).toFixed(2), 'mAU']}
      />
      <Line
        dataKey="v"
        dot={false}
        stroke={CHART_BLUE}
        strokeWidth={tall ? 2 : 1.5}
        isAnimationActive={false}
      />
    </LineChart>
  )

  return (
    <>
      <div className="relative h-52 w-full group">
        <ResponsiveContainer width="100%" height="100%">
          {chartInner(false)}
        </ResponsiveContainer>
        <button
          onClick={() => setExpanded(true)}
          className="absolute top-1.5 right-1.5 p-1 rounded bg-background/60 border border-border/40 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-background/90 transition-all cursor-pointer"
          aria-label="Expand chromatogram"
          title="View full size"
        >
          <Maximize2 size={12} />
        </button>
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-[90vw] sm:max-w-[90vw] w-[90vw]">
          <DialogTitle className="text-sm font-medium truncate pr-6">
            {attachment.filename}
          </DialogTitle>
          <div className="h-[60vh] w-full">
            <ResponsiveContainer width="100%" height="100%">
              {chartInner(true)}
            </ResponsiveContainer>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Renders an LTTB-compressed chromatogram fetched via the backend proxy. */
function LttbJsonChart({
  verificationCode,
  resolution,
  label,
}: {
  verificationCode: string
  resolution: '5k' | '10k'
  label: string
}) {
  const [chartData, setChartData] = useState<{ t: number; v: number }[]>([])
  const [peaks, setPeaks] = useState<
    { retention_time: number; height: number; area_percent: number }[]
  >([])
  const [meta, setMeta] = useState<{
    points: number
    source_points: number
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    fetchChromatogramLttb(verificationCode, resolution)
      .then(json => {
        if (cancelled) return
        const pts = json.x.map((t, i) => ({ t, v: json.y[i] ?? 0 }))
        setChartData(pts)
        setPeaks(json.peaks ?? [])
        setMeta(
          json.points && json.source_points
            ? { points: json.points, source_points: json.source_points }
            : null
        )
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [verificationCode, resolution])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-52 rounded-lg bg-muted/40 border border-border/30">
        <Spinner className="size-5" />
      </div>
    )
  }
  if (error || chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-52 rounded-lg bg-muted/40 border border-border/30">
        <span className="text-xs text-muted-foreground">
          Failed to load {label} data
        </span>
      </div>
    )
  }

  const chartInner = (tall: boolean) => (
    <LineChart
      data={chartData}
      margin={{ top: 8, right: 16, bottom: 20, left: tall ? 8 : 4 }}
    >
      <CartesianGrid
        strokeDasharray="3 3"
        stroke={CHART_GRID}
        vertical={false}
      />
      <XAxis
        dataKey="t"
        type="number"
        domain={['dataMin', 'dataMax']}
        tick={{ fontSize: tall ? 11 : 9, fill: CHART_SLATE }}
        axisLine={{ stroke: CHART_GRID }}
        tickLine={false}
        tickFormatter={(v: number) => v.toFixed(1)}
        label={{
          value: 'min',
          position: 'insideBottom',
          offset: -10,
          style: { fontSize: tall ? 11 : 9, fill: CHART_SLATE },
        }}
      />
      <YAxis
        tick={{ fontSize: tall ? 11 : 9, fill: CHART_SLATE }}
        axisLine={false}
        tickLine={false}
        tickFormatter={(v: number) =>
          v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(Math.round(v))
        }
        width={tall ? 48 : 40}
      />
      <Tooltip
        contentStyle={{
          backgroundColor: '#1e293b',
          border: '1px solid #475569',
          borderRadius: 6,
          fontSize: tall ? 12 : 10,
        }}
        labelStyle={{ color: CHART_SLATE }}
        itemStyle={{ color: '#e2e8f0' }}
        labelFormatter={v => `${Number(v).toFixed(3)} min`}
        formatter={value => [Number(value).toFixed(2), 'mAU']}
      />
      <Line
        dataKey="v"
        dot={false}
        stroke={CHART_BLUE}
        strokeWidth={tall ? 2 : 1.5}
        isAnimationActive={false}
      />
    </LineChart>
  )

  return (
    <>
      <div className="relative h-52 w-full group">
        <ResponsiveContainer width="100%" height="100%">
          {chartInner(false)}
        </ResponsiveContainer>
        <button
          onClick={() => setExpanded(true)}
          className="absolute top-1.5 right-1.5 p-1 rounded bg-background/60 border border-border/40 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-background/90 transition-all cursor-pointer"
          aria-label="Expand chromatogram"
          title="View full size"
        >
          <Maximize2 size={12} />
        </button>
        {meta && (
          <span className="absolute bottom-1.5 left-1.5 text-[9px] text-muted-foreground/60">
            {meta.points.toLocaleString()} pts (from{' '}
            {meta.source_points.toLocaleString()})
          </span>
        )}
      </div>

      {/* Peak table */}
      {peaks.length > 0 && (
        <div className="mt-1.5">
          <table className="w-full text-[10px] text-muted-foreground">
            <thead>
              <tr className="border-b border-border/30">
                <th className="text-left py-0.5 font-medium">RT (min)</th>
                <th className="text-right py-0.5 font-medium">Height</th>
                <th className="text-right py-0.5 font-medium">Area %</th>
              </tr>
            </thead>
            <tbody>
              {peaks.map((p, i) => (
                <tr key={i} className="border-b border-border/20">
                  <td className="py-0.5">{p.retention_time.toFixed(3)}</td>
                  <td className="text-right py-0.5">{p.height.toFixed(1)}</td>
                  <td className="text-right py-0.5">
                    {p.area_percent.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-[90vw] sm:max-w-[90vw] w-[90vw]">
          <DialogTitle className="text-sm font-medium truncate pr-6">
            {label}
          </DialogTitle>
          <div className="h-[60vh] w-full">
            <ResponsiveContainer width="100%" height="100%">
              {chartInner(true)}
            </ResponsiveContainer>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

type ChromatogramTab = 'raw' | '5k' | '10k'

/** Tabbed chromatogram viewer: Raw CSV, LTTB 5k, LTTB 10k */
function TabbedChromatogramChart({
  attachment,
  verificationCode,
  has5k,
  has10k,
}: {
  attachment: SenaiteAttachment
  verificationCode: string | null
  has5k: boolean
  has10k: boolean
}) {
  const hasTabs = !!(has5k || has10k)
  const [activeTab, setActiveTab] = useState<ChromatogramTab>('raw')

  const tabs: { key: ChromatogramTab; label: string; available: boolean }[] = [
    { key: 'raw', label: 'Raw CSV', available: true },
    { key: '5k', label: 'LTTB 5k', available: has5k },
    { key: '10k', label: 'LTTB 10k', available: has10k },
  ]

  return (
    <div>
      {hasTabs && (
        <div className="flex gap-1 mb-2">
          {tabs
            .filter(t => t.available)
            .map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className={cn(
                  'px-2 py-0.5 text-[10px] rounded-md border transition-colors cursor-pointer',
                  activeTab === t.key
                    ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                    : 'bg-muted/40 border-border/30 text-muted-foreground hover:text-foreground hover:bg-muted/60'
                )}
              >
                {t.label}
              </button>
            ))}
        </div>
      )}

      {activeTab === 'raw' && <HplcAttachmentChart attachment={attachment} />}
      {activeTab === '5k' && verificationCode && (
        <LttbJsonChart
          verificationCode={verificationCode}
          resolution="5k"
          label="LTTB 5k"
        />
      )}
      {activeTab === '10k' && verificationCode && (
        <LttbJsonChart
          verificationCode={verificationCode}
          resolution="10k"
          label="LTTB 10k"
        />
      )}
    </div>
  )
}

const ATTACHMENT_TYPES: SenaiteAttachmentType[] = ['HPLC Graph', 'Sample Image']

const isHplcGraph = (a: SenaiteAttachment) =>
  a.attachment_type === 'HPLC Graph' ||
  a.filename?.toLowerCase().endsWith('.csv') === true

const isRenderable = (a: SenaiteAttachment) =>
  a.content_type?.startsWith('image/') || isHplcGraph(a)

function AddAttachmentForm({
  sampleUid,
  onUploaded,
}: {
  sampleUid: string
  onUploaded: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [attachmentType, setAttachmentType] =
    useState<SenaiteAttachmentType>('HPLC Graph')
  const [isUploading, setIsUploading] = useState(false)

  const handleUpload = async () => {
    if (!file) return
    setIsUploading(true)
    try {
      const result = await uploadSenaiteAttachment(
        sampleUid,
        file,
        attachmentType
      )
      if (result.success) {
        toast.success('Attachment uploaded')
        setFile(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
        onUploaded()
      } else {
        toast.error('Upload failed', { description: result.message })
      }
    } catch (err) {
      toast.error('Upload failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsUploading(false)
    }
  }

  return (
    <div
      className="pt-3 border-t border-border/40"
      onClick={e => e.stopPropagation()}
    >
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
        Add Attachment
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border bg-muted/40 hover:bg-muted cursor-pointer transition-colors disabled:opacity-50"
        >
          <Paperclip size={13} />
          {file ? file.name : 'Choose file'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={e => setFile(e.target.files?.[0] ?? null)}
          disabled={isUploading}
        />
        <select
          value={attachmentType}
          onChange={e =>
            setAttachmentType(e.target.value as SenaiteAttachmentType)
          }
          disabled={isUploading}
          className="h-8 text-sm px-2 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {ATTACHMENT_TYPES.map(t => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          onClick={handleUpload}
          disabled={!file || isUploading}
          className="h-8 gap-1.5"
        >
          {isUploading ? (
            <Spinner className="size-3.5" />
          ) : (
            <Upload size={13} />
          )}
          Upload
        </Button>
      </div>
    </div>
  )
}

// ── Vial (Mk1) attachments — sub-sample pages only ───────────────────────────
// Check-in photo (replace/remove) + extra sample images, all stored Mk1-side.
// docs/superpowers/specs/2026-06-11-subsample-attachments-design.md

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.readAsDataURL(file)
  })
}

/** Trash button that arms on first click (avoids window.confirm, which is
 *  unreliable in the Tauri webview) and fires on the second within 3s. */
function ArmedDeleteButton({
  onConfirm,
  label,
}: {
  onConfirm: () => void
  label: string
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation()
        if (armed) {
          setArmed(false)
          onConfirm()
        } else {
          setArmed(true)
        }
      }}
      title={armed ? `Click again to remove ${label}` : `Remove ${label}`}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors cursor-pointer shrink-0',
        armed
          ? 'border-red-500/60 bg-red-500/15 text-red-600 dark:text-red-400'
          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      <Trash2 size={11} />
      {armed ? 'Confirm?' : 'Remove'}
    </button>
  )
}

function VialAttachmentImage({
  sampleId,
  attachmentId,
  filename,
}: {
  sampleId: string
  attachmentId: number
  filename: string
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetchSubSampleAttachmentUrl(sampleId, attachmentId)
      .then(url => {
        if (!cancelled) setSrc(url)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sampleId, attachmentId])

  if (loading) {
    return (
      <div className="flex items-center justify-center w-full h-48 rounded-lg bg-muted/40 border border-border/30">
        <Spinner className="size-5" />
      </div>
    )
  }
  if (error || !src) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 w-full h-48 rounded-lg bg-muted/40 border border-border/30">
        <ImageIcon size={24} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          Failed to load image
        </span>
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={filename}
      className="rounded-lg border border-border/30 max-h-40 w-auto object-contain"
    />
  )
}

/** In-app chromatogram chart for a vial chromatogram's raw series — the same
 *  recharts treatment as HplcAttachmentChart (dark theme), NOT the branded
 *  COA PNG. `compact` renders a small non-interactive trace for picker cards
 *  (pointer-events pass through to the card's click handler). */
function VialChromatogramChart({
  data,
  title,
  compact = false,
}: {
  data: { times: number[]; signals: number[] }
  title: string
  compact?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const chartData = data.times.map((t, i) => ({ t, v: data.signals[i] ?? 0 }))

  const chartInner = (tall: boolean) => (
    <LineChart
      data={chartData}
      margin={{
        top: 8,
        right: 16,
        bottom: compact ? 4 : 20,
        left: tall ? 8 : 4,
      }}
    >
      <CartesianGrid
        strokeDasharray="3 3"
        stroke={CHART_GRID}
        vertical={false}
      />
      <XAxis
        dataKey="t"
        type="number"
        domain={['dataMin', 'dataMax']}
        tick={{ fontSize: tall ? 11 : 9, fill: CHART_SLATE }}
        axisLine={{ stroke: CHART_GRID }}
        tickLine={false}
        tickFormatter={(v: number) => v.toFixed(1)}
        {...(compact
          ? {}
          : {
              label: {
                value: 'min',
                position: 'insideBottom' as const,
                offset: -10,
                style: { fontSize: tall ? 11 : 9, fill: CHART_SLATE },
              },
            })}
      />
      <YAxis
        tick={{ fontSize: tall ? 11 : 9, fill: CHART_SLATE }}
        axisLine={false}
        tickLine={false}
        tickFormatter={(v: number) =>
          v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(Math.round(v))
        }
        width={tall ? 48 : 40}
      />
      {!compact && (
        <Tooltip
          contentStyle={{
            backgroundColor: '#1e293b',
            border: '1px solid #475569',
            borderRadius: 6,
            fontSize: tall ? 12 : 10,
          }}
          labelStyle={{ color: CHART_SLATE }}
          itemStyle={{ color: '#e2e8f0' }}
          labelFormatter={v => `${Number(v).toFixed(3)} min`}
          formatter={value => [Number(value).toFixed(2), 'mAU']}
        />
      )}
      <Line
        dataKey="v"
        dot={false}
        stroke={CHART_BLUE}
        strokeWidth={tall ? 2 : 1.5}
        isAnimationActive={false}
      />
    </LineChart>
  )

  if (compact) {
    return (
      <div className="h-28 w-full pointer-events-none rounded-lg border border-border/30 bg-muted/20">
        <ResponsiveContainer width="100%" height="100%">
          {chartInner(false)}
        </ResponsiveContainer>
      </div>
    )
  }

  return (
    <>
      <div className="relative h-52 w-full group rounded-lg border border-border/30 bg-muted/20">
        <ResponsiveContainer width="100%" height="100%">
          {chartInner(false)}
        </ResponsiveContainer>
        <button
          onClick={e => {
            e.stopPropagation()
            setExpanded(true)
          }}
          className="absolute top-1.5 right-1.5 p-1 rounded bg-background/60 border border-border/40 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-background/90 transition-all cursor-pointer"
          aria-label="Expand chromatogram"
          title="View full size"
        >
          <Maximize2 size={12} />
        </button>
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-[90vw] sm:max-w-[90vw] w-[90vw]">
          <DialogTitle className="text-sm font-medium truncate pr-6">
            {title}
          </DialogTitle>
          <div className="h-[60vh] w-full">
            <ResponsiveContainer width="100%" height="100%">
              {chartInner(true)}
            </ResponsiveContainer>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function AddVialImageForm({
  sampleId,
  onUploaded,
}: {
  sampleId: string
  onUploaded: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)

  const handleUpload = async () => {
    if (!file) return
    setIsUploading(true)
    try {
      const dataUrl = await fileToDataUrl(file)
      await uploadSubSampleAttachment(sampleId, dataUrl, file.name)
      toast.success('Image attached')
      setFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      onUploaded()
    } catch (err) {
      toast.error('Upload failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsUploading(false)
    }
  }

  return (
    <div
      className="pt-3 border-t border-border/40"
      onClick={e => e.stopPropagation()}
    >
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
        Add Sample Image
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border bg-muted/40 hover:bg-muted cursor-pointer transition-colors disabled:opacity-50"
        >
          <ImageIcon size={13} />
          {file ? file.name : 'Choose image'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={e => setFile(e.target.files?.[0] ?? null)}
          disabled={isUploading}
        />
        <Button
          size="sm"
          onClick={handleUpload}
          disabled={!file || isUploading}
          className="h-8 gap-1.5"
        >
          {isUploading ? (
            <Spinner className="size-3.5" />
          ) : (
            <Upload size={13} />
          )}
          Upload
        </Button>
      </div>
    </div>
  )
}

function VialAttachmentsBlock({
  sampleId,
  photoUrl,
  photoIsMk1,
  attachments,
  chromatograms,
  onPhotoChanged,
  onAttachmentsChanged,
}: {
  sampleId: string
  photoUrl: string | null
  /** Remove/make-primary are only offered for Mk1-stored photos; legacy
   *  SENAITE photos live on the parent AR and can't be deleted or demoted
   *  from here. */
  photoIsMk1: boolean
  attachments: SubSampleAttachment[]
  /** Chromatograms from this vial's HPLC preps (derived, read-only —
   *  the data lives on hplc_analyses, nothing to add/remove here). */
  chromatograms: SubSampleChromatogram[]
  onPhotoChanged: () => void
  onAttachmentsChanged: () => void
}) {
  // Promoting an extra image swaps it into the photo slot, demoting the
  // current photo to a regular attachment — needs the current photo to be
  // Mk1-stored (or absent).
  const canSetPrimary = photoIsMk1 || !photoUrl
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const handleReplaceFile = async (file: File | null) => {
    if (!file) return
    setBusy(true)
    try {
      const dataUrl = await fileToDataUrl(file)
      await updateSubSample(sampleId, { photoBase64: dataUrl })
      invalidateSubSamplePhoto(sampleId)
      toast.success(photoUrl ? 'Vial photo replaced' : 'Vial photo added')
      onPhotoChanged()
    } catch (err) {
      toast.error('Photo update failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setBusy(false)
      if (replaceInputRef.current) replaceInputRef.current.value = ''
    }
  }

  const handleRemovePhoto = async () => {
    setBusy(true)
    try {
      await deleteSubSamplePhoto(sampleId)
      toast.success('Vial photo removed')
      onPhotoChanged()
    } catch (err) {
      toast.error('Remove failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteAttachment = async (att: SubSampleAttachment) => {
    try {
      await deleteSubSampleAttachment(sampleId, att.id)
      toast.success(`Removed ${att.filename}`)
      onAttachmentsChanged()
    } catch (err) {
      toast.error('Remove failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  const handleMakePrimary = async (att: SubSampleAttachment) => {
    setBusy(true)
    try {
      await setSubSamplePrimaryAttachment(sampleId, att.id)
      toast.success(`${att.filename} is now the vial photo`)
      // Both lists change: photo slot took the promoted image; the old photo
      // (if any) reappears as a regular attachment.
      onPhotoChanged()
      onAttachmentsChanged()
    } catch (err) {
      toast.error('Could not set primary', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => void handleReplaceFile(e.target.files?.[0] ?? null)}
        disabled={busy}
      />
      {/* Check-in photo card */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <ImageIcon size={13} className="text-muted-foreground shrink-0" />
          <span className="text-xs font-medium text-foreground truncate">
            Vial Photo
          </span>
          <Badge variant="secondary" className="text-[10px] shrink-0">
            Check-in
          </Badge>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                replaceInputRef.current?.click()
              }}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer disabled:opacity-50 shrink-0"
            >
              {busy ? <Spinner className="size-3" /> : <RefreshCw size={11} />}
              {photoUrl ? 'Replace' : 'Add Photo'}
            </button>
            {photoUrl && photoIsMk1 && !busy && (
              <ArmedDeleteButton
                onConfirm={() => void handleRemovePhoto()}
                label="vial photo"
              />
            )}
          </div>
        </div>
        {photoUrl ? (
          <img
            src={photoUrl}
            alt={`${sampleId} vial photo`}
            className="rounded-lg border border-border/30 max-h-40 w-auto object-contain"
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 w-full h-24 rounded-lg bg-muted/40 border border-dashed border-border/50">
            <ImageIcon size={20} className="text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              No vial photo on file
            </span>
          </div>
        )}
      </div>

      {/* Chromatograms — derived from this vial's HPLC preps (read-only) */}
      {chromatograms.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {chromatograms.map(c => (
            <div key={c.analysis_id} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Activity
                  size={13}
                  className="text-muted-foreground shrink-0"
                />
                <span className="text-xs font-medium text-foreground truncate">
                  Chromatogram
                  {c.peptide_abbreviation ? ` — ${c.peptide_abbreviation}` : ''}
                </span>
                <Badge variant="secondary" className="text-[10px] shrink-0">
                  HPLC Prep
                </Badge>
                {c.created_at && (
                  <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
                    {new Date(c.created_at).toLocaleDateString()}
                  </span>
                )}
              </div>
              <VialChromatogramChart
                data={c.data}
                title={`${c.vial_sample_id} — ${c.peptide_abbreviation ?? 'Chromatogram'}`}
              />
            </div>
          ))}
        </div>
      )}

      {/* Extra sample images */}
      {attachments.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {attachments.map(att => (
            <div key={att.id} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <ImageIcon
                  size={13}
                  className="text-muted-foreground shrink-0"
                />
                <span className="text-xs font-medium text-foreground truncate">
                  {att.filename}
                </span>
                <Badge variant="secondary" className="text-[10px] shrink-0">
                  Sample Image
                </Badge>
                <div className="ml-auto flex items-center gap-1.5">
                  {canSetPrimary && (
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation()
                        void handleMakePrimary(att)
                      }}
                      disabled={busy}
                      title="Make this the vial's primary photo (shown in the header; the current photo becomes a regular attachment)"
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer disabled:opacity-50 shrink-0"
                    >
                      <Star size={11} />
                      Primary
                    </button>
                  )}
                  <ArmedDeleteButton
                    onConfirm={() => void handleDeleteAttachment(att)}
                    label={att.filename}
                  />
                </div>
              </div>
              <VialAttachmentImage
                sampleId={sampleId}
                attachmentId={att.id}
                filename={att.filename}
              />
            </div>
          ))}
        </div>
      )}

      <AddVialImageForm sampleId={sampleId} onUploaded={onAttachmentsChanged} />
    </div>
  )
}

/**
 * Parent-page overlay: pick which vial's primary photo to attach to the
 * parent. Snapshot semantics — the chosen image is uploaded to the parent AR
 * in SENAITE as a "Sample Image" attachment (becoming the parent's newest
 * image, which the header thumb and COA flows already consume). Only vials
 * with Mk1-stored primaries are offered; pre-cutover legacy vial photos
 * already live on the parent AR.
 */
function SelectVialImageDialog({
  open,
  onOpenChange,
  parentSampleId,
  parentSampleUid,
  vials,
  containerMode,
  onAttached,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentSampleId: string
  parentSampleUid: string
  vials: SubSample[]
  containerMode: boolean
  onAttached: () => void
}) {
  const [attachingId, setAttachingId] = useState<string | null>(null)
  const eligible = vials.filter(v => v.photo_external_uid?.startsWith('mk1://'))

  const handleSelect = async (vial: SubSample) => {
    setAttachingId(vial.sample_id)
    try {
      const url = await fetchSubSamplePhotoUrl(vial.sample_id)
      if (!url) throw new Error('Could not load the vial photo')
      const blob = await (await fetch(url)).blob()
      const ext =
        {
          'image/png': '.png',
          'image/jpeg': '.jpg',
          'image/gif': '.gif',
          'image/webp': '.webp',
        }[blob.type] ?? '.jpg'
      const file = new File([blob], `${vial.sample_id}-vial-photo${ext}`, {
        type: blob.type || 'image/jpeg',
      })
      const result = await uploadSenaiteAttachment(
        parentSampleUid,
        file,
        'Sample Image'
      )
      if (!result.success) throw new Error(result.message)
      // Seed the parent's photo cache with the exact bytes so the header
      // thumb updates instantly — the SENAITE attachment listing has a
      // read-after-write window the immediate refetch would lose to.
      seedSubSamplePhoto(
        parentSampleId,
        new Uint8Array(await blob.arrayBuffer())
      )
      toast.success(`${vial.sample_id} photo attached to ${parentSampleId}`)
      onAttached()
      onOpenChange(false)
    } catch (err) {
      toast.error('Attach failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setAttachingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Select Vial Image</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground -mt-2">
          Choose which vial&apos;s primary photo to attach to {parentSampleId}.
          The image is uploaded to SENAITE as a Sample Image attachment and
          becomes the parent&apos;s newest image.
        </p>
        {eligible.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No vial photos available.
          </p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto pr-1">
            {eligible.map(v => (
              <button
                key={v.sample_id}
                type="button"
                disabled={attachingId !== null}
                onClick={() => void handleSelect(v)}
                className="group text-left rounded-lg border border-border/50 bg-muted/20 hover:border-primary/60 hover:bg-muted/50 transition-colors p-2 space-y-1.5 cursor-pointer disabled:opacity-60"
              >
                <VialPhotoThumb
                  sampleId={v.sample_id}
                  hasPhoto
                  sizeClass="w-full h-28"
                />
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-medium text-foreground">
                    {vialLabel(v.vial_sequence, containerMode)}
                  </span>
                  {v.assignment_role && (
                    <RoleHeaderBadge role={v.assignment_role} />
                  )}
                  {v.assignment_kind === 'variance' && (
                    <span className="inline-block text-[10px] leading-none px-1.5 py-0.5 rounded border uppercase tracking-wide font-medium bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300">
                      Variance
                    </span>
                  )}
                  {attachingId === v.sample_id && (
                    <Spinner className="size-3" />
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground font-mono">
                  {v.sample_id}
                </div>
                {v.received_at && (
                  <div className="text-[10px] text-muted-foreground">
                    Received {new Date(v.received_at).toLocaleDateString()}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Parent-page overlay: pick which vial's chromatogram to attach to the
 * parent. Snapshot semantics, mirroring SelectVialImageDialog — the chosen
 * analysis's chromatogram CSV is uploaded to the parent AR in SENAITE as an
 * "HPLC Graph" attachment (existing /chromatogram-to-senaite route), which
 * the attachments section and COA generation consume natively.
 */
function SelectVialChromatogramDialog({
  open,
  onOpenChange,
  parentSampleId,
  parentSampleUid,
  chromatograms,
  containerMode,
  onAttached,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentSampleId: string
  parentSampleUid: string
  chromatograms: SubSampleChromatogram[]
  containerMode: boolean
  onAttached: () => void
}) {
  const [attachingId, setAttachingId] = useState<number | null>(null)

  const handleSelect = async (c: SubSampleChromatogram) => {
    setAttachingId(c.analysis_id)
    try {
      const result = await uploadChromatogramToSenaite(
        c.analysis_id,
        parentSampleUid
      )
      if (!result.success) throw new Error(result.message)
      toast.success(
        `${c.vial_sample_id} chromatogram attached to ${parentSampleId}`
      )
      onAttached()
      onOpenChange(false)
    } catch (err) {
      toast.error('Attach failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setAttachingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Select Vial Chromatogram</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground -mt-2">
          Choose which vial&apos;s chromatogram to attach to {parentSampleId}.
          The CSV is uploaded to SENAITE as an HPLC Graph attachment and becomes
          the parent&apos;s newest chromatogram (used by the COA).
        </p>
        {chromatograms.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No vial chromatograms available — process an HPLC prep for a vial
            first.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pr-1">
            {chromatograms.map(c => (
              <button
                key={c.analysis_id}
                type="button"
                disabled={attachingId !== null}
                onClick={() => void handleSelect(c)}
                className="group text-left rounded-lg border border-border/50 bg-muted/20 hover:border-primary/60 hover:bg-muted/50 transition-colors p-2 space-y-1.5 cursor-pointer disabled:opacity-60"
              >
                <VialChromatogramChart
                  data={c.data}
                  title={`${c.vial_sample_id} — ${c.peptide_abbreviation ?? 'Chromatogram'}`}
                  compact
                />
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-medium text-foreground">
                    {vialLabel(c.vial_sequence, containerMode)}
                  </span>
                  {c.assignment_role && (
                    <RoleHeaderBadge role={c.assignment_role} />
                  )}
                  {c.assignment_kind === 'variance' && (
                    <span className="inline-block text-[10px] leading-none px-1.5 py-0.5 rounded border uppercase tracking-wide font-medium bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300">
                      Variance
                    </span>
                  )}
                  {c.peptide_abbreviation && (
                    <Badge variant="secondary" className="text-[10px] shrink-0">
                      {c.peptide_abbreviation}
                    </Badge>
                  )}
                  {attachingId === c.analysis_id && (
                    <Spinner className="size-3" />
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground font-mono">
                  {c.vial_sample_id}
                </div>
                {c.created_at && (
                  <div className="text-[10px] text-muted-foreground">
                    {new Date(c.created_at).toLocaleDateString()}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DataRow({
  label,
  value,
  mono = false,
  emphasis = false,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
  emphasis?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between py-1.5 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0 min-w-28 mr-3">
        {label}
      </span>
      <div className="flex items-center gap-1">
        <span
          className={`text-sm text-right ${
            emphasis ? 'font-semibold text-foreground' : 'text-foreground'
          } ${mono ? 'font-mono' : ''}`}
        >
          {value || '—'}
        </span>
        {/* Spacer matching the EditableField pencil icon size for column alignment */}
        <span className="inline-block w-[11px] shrink-0" aria-hidden="true" />
      </div>
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  title,
  children,
  defaultOpen = true,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const contentId = useId()
  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex items-center gap-2 w-full text-left group mb-2 cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center justify-center w-6 h-6 rounded-md bg-muted group-hover:bg-muted/80 transition-colors">
          {open ? (
            <ChevronDown size={14} className="text-muted-foreground" />
          ) : (
            <ChevronRight size={14} className="text-muted-foreground" />
          )}
        </div>
        <Icon size={15} className="text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground tracking-wide uppercase">
          {title}
        </span>
      </button>
      {open && <div id={contentId}>{children}</div>}
    </div>
  )
}

// Status styling constants moved to AnalysisTable.tsx

// --- Analysis Profile theming ---

// StatusBadge and TabButton moved to AnalysisTable.tsx

function AccuVerifyBadge({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scriptLoaded = useRef(false)
  const wpBase = getWordpressUrl() || 'https://accumarklabs.com'
  const { theme } = useTheme()
  const badgeTheme =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme

  useEffect(() => {
    const scriptUrl = `${wpBase}/wp-content/themes/wpstar/js/accuverify-badge-embed.js`
    if (scriptLoaded.current) return
    const existing = document.querySelector(`script[src="${scriptUrl}"]`)
    if (existing) {
      scriptLoaded.current = true
      return
    }
    const script = document.createElement('script')
    script.type = 'module'
    script.src = scriptUrl
    script.onload = () => {
      scriptLoaded.current = true
    }
    document.head.appendChild(script)
  }, [wpBase])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.innerHTML = ''
    const badge = document.createElement('accuverify-badge')
    badge.setAttribute('code', code)
    badge.setAttribute('theme', badgeTheme)
    badge.setAttribute('size', 'full')
    container.appendChild(badge)
  }, [code, badgeTheme])

  return <div ref={containerRef} className="min-h-[200px]" />
}

function accuverifyUrl(code: string): string {
  return `${getWordpressUrl()}/accuverify/?accuverify_code=${encodeURIComponent(code)}`
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// --- Customer Remarks (delivered with the published COA) ---

function CustomerRemarksCard({
  sampleId,
  initial,
  initialInclude,
  deliveredAt,
  onSaved,
}: {
  sampleId: string
  initial: string
  initialInclude: boolean
  deliveredAt: string | null
  onSaved: () => void
}) {
  const [text, setText] = useState(initial)
  const [include, setInclude] = useState(initialInclude)
  const [saving, setSaving] = useState(false)
  const dirty = text !== initial || include !== initialInclude

  async function handleSave() {
    setSaving(true)
    try {
      await updateCustomerRemarks(sampleId, text.trim(), include)
      toast.success('Customer remarks saved')
      onSaved()
    } catch (err) {
      toast.error('Failed to save customer remarks', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <Textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Short customer-facing summary delivered with the published COA…"
        className="min-h-24 text-sm"
        aria-label={`Customer remarks for ${sampleId}`}
        disabled={saving}
      />
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={include}
          onCheckedChange={v => setInclude(v === true)}
          disabled={saving}
          aria-label="Include with publish"
        />
        Include with Publish?
      </label>
      {deliveredAt && (
        <p className="text-[11px] font-medium text-orange-300">
          Delivered to Customer {formatDate(deliveredAt)}
        </p>
      )}
      <div className="flex items-center justify-between gap-4">
        <p className="text-[11px] text-muted-foreground">
          Delivered to the customer with the published COA when included.
          Required when the COA is non-conforming (unless suppressed).
          Re-publish the COA to refresh the customer copy.
        </p>
        <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

// --- Add Remark Form ---

function AddRemarkForm({
  sampleUid,
  sampleId,
  onAdded,
}: {
  sampleUid: string
  sampleId: string
  onAdded: () => void
}) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)

  async function handleSubmit() {
    const trimmed = text.trim()
    if (!trimmed) return

    setSaving(true)
    try {
      const result = await updateSenaiteSampleFields(sampleUid, {
        Remarks: trimmed,
      })
      if (!result.success) throw new Error(result.message)
      toast.success('Remark added')
      setText('')
      setOpen(false)
      onAdded()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      toast.error('Failed to add remark', { description: msg })
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center gap-1.5"
      >
        <MessageSquare size={12} />
        Add remark
      </button>
    )
  }

  return (
    <div className="mt-3 pt-3 border-t border-border space-y-2">
      <Textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Type your remark..."
        disabled={saving}
        className="min-h-15 text-sm"
        aria-label={`Add remark to ${sampleId}`}
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
          size="sm"
          onClick={handleSubmit}
          disabled={saving || !text.trim()}
          className="cursor-pointer gap-1.5"
        >
          {saving && <Spinner className="size-3.5" />}
          Add Remark
        </Button>
      </div>
    </div>
  )
}

// --- Additional COA Card (collapsible) ---

function AdditionalCoaCard({
  coa,
  sampleId,
  onUpdateState,
  onRegenerated,
}: {
  coa: AdditionalCOAConfig
  sampleId: string
  onUpdateState: (
    field: keyof AdditionalCOAConfig['coa_info'],
    newValue: string | number | null
  ) => void
  onRegenerated: () => void
}) {
  const [open, setOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [regenerating, setRegenerating] = useState(false)

  const handleRegen = async () => {
    const confirmed = window.confirm(
      `Regenerate & republish additional COA #${coa.coa_index} ` +
        `(${coa.coa_info.company_name || 'Untitled'}) for ${sampleId}?\n\n` +
        `This mints a NEW verification code for this additional COA only.\n` +
        `Primary and other additional COAs are untouched.`
    )
    if (!confirmed) return
    setRegenerating(true)
    try {
      const result = await regenAdditionalCOA(coa.config_id)
      if (result.success) {
        toast.success(`Additional COA #${coa.coa_index} regenerated`, {
          description: result.verification_code
            ? `New code: ${result.verification_code}`
            : undefined,
        })
        onRegenerated()
      } else {
        toast.error('Regen failed', { description: result.message })
      }
    } catch (err) {
      toast.error('Regen failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setRegenerating(false)
    }
  }

  const updateCoaField =
    (field: keyof AdditionalCOAConfig['coa_info']) =>
    async (newValue: string | number | null) => {
      await updateAdditionalCOAConfig(coa.config_id, {
        [field]: newValue as string | null,
      })
    }

  const updateCoaState =
    (field: keyof AdditionalCOAConfig['coa_info']) =>
    (newValue: string | number | null) => {
      onUpdateState(field, newValue)
    }

  const handleDownload = async () => {
    if (!coa.generation_number) return
    setDownloading(true)
    try {
      const { url } = await getExplorerCOASignedUrl(
        sampleId,
        coa.generation_number
      )
      window.open(url, '_blank')
    } catch {
      toast.error('Failed to open COA PDF')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="rounded-lg bg-muted/50 border border-border/30">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full p-2.5 cursor-pointer rounded-lg hover:bg-muted/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? (
            <ChevronDown size={13} className="text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight
              size={13}
              className="text-muted-foreground shrink-0"
            />
          )}
          <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
            #{coa.coa_index}
          </span>
          <span className="text-sm font-medium text-foreground truncate">
            {coa.coa_info.company_name || 'Untitled COA'}
          </span>
        </div>
        <Badge
          variant={
            coa.status === 'published'
              ? 'default'
              : coa.status === 'generated'
                ? 'secondary'
                : coa.status === 'failed'
                  ? 'destructive'
                  : 'outline'
          }
          className="text-[10px] shrink-0"
        >
          {coa.status}
        </Badge>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 space-y-1">
          {/* Verification code + PDF download */}
          <div className="flex items-center justify-between py-1.5 border-b border-border/50">
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-xs text-muted-foreground shrink-0 min-w-28 mr-3">
                Verification Code
              </span>
              {coa.verification_code ? (
                <>
                  <a
                    href={accuverifyUrl(coa.verification_code)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-mono text-foreground truncate hover:underline"
                  >
                    {coa.verification_code}
                  </a>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(coa.verification_code!)
                      toast.success('Verification code copied')
                    }}
                    className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors cursor-pointer ml-1"
                    aria-label="Copy verification code"
                  >
                    <Copy size={11} />
                  </button>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-2">
              {coa.status === 'published' && coa.verification_code && (
                <a
                  href={accuverifyUrl(coa.verification_code)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                >
                  View Digital COA
                </a>
              )}
              {coa.generation_number && (
                <button
                  onClick={handleDownload}
                  disabled={downloading}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {downloading ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <ExternalLink size={11} />
                  )}
                  PDF
                </button>
              )}
              {coa.generation_id && (
                <button
                  onClick={handleRegen}
                  disabled={regenerating}
                  title="Regenerate & republish just this additional COA. Mints a new verification code."
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 transition-colors disabled:opacity-50 cursor-pointer dark:text-amber-400"
                >
                  {regenerating ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <RefreshCw size={11} />
                  )}
                  Regen
                </button>
              )}
            </div>
          </div>
          <EditableDataRow
            label="Company"
            value={coa.coa_info.company_name ?? null}
            emphasis
            onSave={updateCoaField('company_name')}
            onSaved={updateCoaState('company_name')}
          />
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0 space-y-0">
              <EditableDataRow
                label="Website"
                value={coa.coa_info.website ?? null}
                onSave={updateCoaField('website')}
                onSaved={updateCoaState('website')}
              />
              <EditableDataRow
                label="Email"
                value={coa.coa_info.email ?? null}
                onSave={updateCoaField('email')}
                onSaved={updateCoaState('email')}
              />
              <EditableDataRow
                label="Address"
                value={coa.coa_info.address ?? null}
                onSave={updateCoaField('address')}
                onSaved={updateCoaState('address')}
              />
              <EditableDataRow
                label="Logo URL"
                value={coa.coa_info.logo_url ?? null}
                truncateStart
                onSave={updateCoaField('logo_url')}
                onSaved={updateCoaState('logo_url')}
              />
              <EditableDataRow
                label="Chromat. BG"
                value={coa.coa_info.chromatograph_background_url ?? null}
                truncateStart
                onSave={updateCoaField('chromatograph_background_url')}
                onSaved={updateCoaState('chromatograph_background_url')}
              />
            </div>
            {(coa.coa_info.logo_url ||
              coa.coa_info.chromatograph_background_url) && (
              <div className="flex items-start gap-2 shrink-0">
                {coa.coa_info.logo_url && (
                  <div className="flex flex-col items-center gap-1">
                    <div className="h-10 w-14 rounded border bg-white flex items-center justify-center overflow-hidden">
                      <img
                        src={coa.coa_info.logo_url}
                        alt={`${coa.coa_info.company_name ?? 'COA'} logo`}
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <span className="text-[9px] text-muted-foreground">
                      Logo
                    </span>
                  </div>
                )}
                {coa.coa_info.chromatograph_background_url && (
                  <div className="flex flex-col items-center gap-1">
                    <div className="h-10 w-14 rounded border bg-white flex items-center justify-center overflow-hidden">
                      <img
                        src={coa.coa_info.chromatograph_background_url}
                        alt="Chromatograph background"
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <span className="text-[9px] text-muted-foreground">
                      Chromat.
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// --- WooCommerce Order Flyout ---

function formatUSD(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

const WOO_STATUS_COLOR: Record<string, string> = {
  completed: 'text-emerald-500',
  processing: 'text-blue-400',
  'on-hold': 'text-amber-400',
  pending: 'text-zinc-400',
  cancelled: 'text-red-400',
  refunded: 'text-red-400',
  failed: 'text-red-400',
}

function WooOrderFlyout({
  order,
  loading,
  onClose,
}: {
  order: WooOrder | null
  loading: boolean
  onClose: () => void
}) {
  const subtotal =
    order?.line_items.reduce((s, i) => s + parseFloat(i.subtotal || '0'), 0) ??
    0
  const discountTotal = parseFloat(order?.discount_total ?? '0')
  const shippingTotal = parseFloat(order?.shipping_total ?? '0')
  const taxTotal = parseFloat(order?.total_tax ?? '0')
  const grandTotal = parseFloat(order?.total ?? '0')

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
        style={{
          backdropFilter: 'blur(2px)',
          animation: 'wooFadeIn 0.2s ease-out',
        }}
      />
      {/* Panel */}
      <div
        className="fixed top-0 right-0 h-full w-full max-w-lg z-50 bg-background border-l border-border shadow-2xl overflow-y-auto flex flex-col"
        style={{ animation: 'wooSlideIn 0.25s ease-out' }}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 bg-background/95 border-b border-border backdrop-blur">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">
                Order #{order?.number ?? '…'}
              </h3>
              {order?.status && (
                <span
                  className={cn(
                    'text-xs capitalize',
                    WOO_STATUS_COLOR[order.status] ?? 'text-zinc-400'
                  )}
                >
                  {order.status}
                </span>
              )}
            </div>
            {order?.date_created && (
              <p className="text-xs text-muted-foreground">
                {new Date(order.date_created).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
                {order.payment_method_title
                  ? ` · ${order.payment_method_title}`
                  : ''}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 p-5 space-y-5">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2
                className="animate-spin text-muted-foreground"
                size={22}
              />
            </div>
          )}

          {!loading && !order && (
            <p className="text-sm text-muted-foreground text-center py-16">
              Order not found in WooCommerce
            </p>
          )}

          {!loading && order && (
            <>
              {/* Billing */}
              <section>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  Customer
                </p>
                <div className="rounded-md border border-border p-3 space-y-0.5">
                  {order.billing.company && (
                    <p className="text-sm font-medium">
                      {order.billing.company}
                    </p>
                  )}
                  <p className="text-sm">
                    {order.billing.first_name} {order.billing.last_name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {order.billing.email}
                  </p>
                  {order.billing.phone && (
                    <p className="text-xs text-muted-foreground">
                      {order.billing.phone}
                    </p>
                  )}
                </div>
              </section>

              {/* Line items */}
              {order.line_items.length > 0 && (
                <section>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    Items ({order.line_items.length})
                  </p>
                  <div className="rounded-md border border-border divide-y divide-border">
                    {order.line_items.map(item => (
                      <div
                        key={item.id}
                        className="flex items-start justify-between px-3 py-2.5 gap-3"
                      >
                        <div className="min-w-0">
                          <p className="text-sm leading-snug">{item.name}</p>
                          {item.quantity > 1 && (
                            <p className="text-xs text-muted-foreground">
                              {item.quantity} × {formatUSD(item.price)}
                            </p>
                          )}
                        </div>
                        <span className="text-xs font-mono shrink-0 pt-0.5">
                          {formatUSD(parseFloat(item.subtotal))}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Order summary */}
              <section>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  Summary
                </p>
                <div className="rounded-md border border-border p-3 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="font-mono">{formatUSD(subtotal)}</span>
                  </div>

                  {/* Coupon lines */}
                  {order.coupon_lines.map(c => (
                    <div key={c.id} className="flex justify-between">
                      <span className="text-emerald-500">
                        Coupon:{' '}
                        <span className="font-mono uppercase">{c.code}</span>
                      </span>
                      <span className="font-mono text-emerald-500">
                        −{formatUSD(parseFloat(c.discount))}
                      </span>
                    </div>
                  ))}

                  {/* Flat discount (no coupon lines) */}
                  {order.coupon_lines.length === 0 && discountTotal > 0 && (
                    <div className="flex justify-between">
                      <span className="text-emerald-500">Discount</span>
                      <span className="font-mono text-emerald-500">
                        −{formatUSD(discountTotal)}
                      </span>
                    </div>
                  )}

                  {/* Shipping */}
                  {order.shipping_lines.map(s => (
                    <div key={s.id} className="flex justify-between">
                      <span className="text-muted-foreground">
                        {s.method_title || 'Shipping'}
                      </span>
                      <span className="font-mono">
                        {shippingTotal === 0
                          ? 'Free'
                          : formatUSD(shippingTotal)}
                      </span>
                    </div>
                  ))}

                  {/* Tax */}
                  {taxTotal > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Tax</span>
                      <span className="font-mono">{formatUSD(taxTotal)}</span>
                    </div>
                  )}

                  {/* Total */}
                  <div className="flex justify-between text-sm font-semibold pt-2 border-t border-border">
                    <span>Total</span>
                    <span className="font-mono">{formatUSD(grandTotal)}</span>
                  </div>
                </div>
              </section>

              {/* Customer note */}
              {order.customer_note && (
                <section>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    Customer Note
                  </p>
                  <p className="text-sm text-muted-foreground italic rounded-md border border-border p-3">
                    {order.customer_note}
                  </p>
                </section>
              )}
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes wooSlideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes wooFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </>
  )
}

// --- Main Component ---

export function SampleDetails() {
  const sampleId = useUIStore(state => state.sampleDetailsTargetId)
  const navigateTo = useUIStore(state => state.navigateTo)
  const navigateToSample = useUIStore(state => state.navigateToSample)

  const [data, setData] = useState<SenaiteLookupResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // COA display-alias state.  peptidesCatalog drives the dropdown options for
  // each analyte slot (from each peptide's approved display_aliases list);
  // sampleAliases holds the current per-slot pick for this sample.
  const [peptidesCatalog, setPeptidesCatalog] = useState<PeptideRecord[]>([])
  const [sampleAliases, setSampleAliases] = useState<Map<number, string>>(
    new Map()
  )
  const [additionalCoas, setAdditionalCoas] = useState<AdditionalCOAConfig[]>(
    []
  )
  const [additionalCoaPage, setAdditionalCoaPage] = useState(0)
  const [coaGenerations, setCoaGenerations] = useState<ExplorerCOAGeneration[]>(
    []
  )
  const [isGeneratingCOA, setIsGeneratingCOA] = useState(false)
  const [isGeneratingVialCOAs, setIsGeneratingVialCOAs] = useState(false)
  const [isPublishingCOA, setIsPublishingCOA] = useState(false)
  const [coaConsole, setCoaConsole] = useState<COAConsoleState>({
    visible: false,
    title: '',
    steps: [],
    phase: 'running',
  })
  const consoleTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  const [showOlderImages, setShowOlderImages] = useState(false)
  const [showOlderHplc, setShowOlderHplc] = useState(false)
  const [wooOrderOpen, setWooOrderOpen] = useState(false)
  const [wooOrderData, setWooOrderData] = useState<WooOrder | null>(null)
  const [wooOrderLoading, setWooOrderLoading] = useState(false)

  // HPLC Results flyout
  const [hplcFlyoutPrep, setHplcFlyoutPrep] = useState<SamplePrep | null>(null)
  const [hplcFlyoutMatch, setHplcFlyoutMatch] = useState<HplcScanMatch | null>(
    null
  )

  // Activity log flyout
  const [activityLogOpen, setActivityLogOpen] = useState(false)

  // Registry debug panel (admin-only)
  const [registryDebugOpen, setRegistryDebugOpen] = useState(false)
  const isAdmin = useAuthStore(s => s.user?.role === 'admin')

  // Variance summary dialog (worksheet-variance design 2026-06-02)
  const [varianceSummaryOpen, setVarianceSummaryOpen] = useState(false)

  // Print Label — single-label print for this sample / its sub-samples
  const { printLabel, target: printTarget } = usePrintLabel()

  // Registry read-source toggle: 'mk1' routes the parent-page lookup to the
  // Mk1 registry endpoint instead of the live SENAITE lookup.
  const { source: readSource } = useReadSource()
  // The registry read endpoint is admin-gated (403 for everyone else). A
  // non-admin who hand-sets sessionStorage['registryReadSource']='mk1'
  // must still always read SENAITE.
  const effectiveReadSource = isAdmin ? readSource : 'senaite'

  // Retest relationship metadata (banner + chain links)
  const [retestInfo, setRetestInfo] = useState<
    import('@/lib/api').SampleRetestInfo | null
  >(null)

  // Phase senaite-writeback Task 4: promotion provenance for parent pages.
  // Populated via useEffect below; empty Map on sub-sample pages (gated by
  // !parentSampleId, which is null only when we ARE the parent).
  const [promotionsByKeyword, setPromotionsByKeyword] = useState<
    Map<string, ParentPromotionInfo>
  >(new Map())

  // Parent-line states for sub-sample pages — keyword → SENAITE review_state.
  // Populated via useEffect below; empty object on parent pages (gated by
  // parentSampleId !== null, i.e. we ARE a sub-sample).
  const [parentLineStates, setParentLineStates] = useState<
    Record<string, string>
  >({})

  // Manage analyses panel
  const [manageAnalysesOpen, setManageAnalysesOpen] = useState(false)
  // Parent pages: result edit fields are hidden by default to deter entering
  // values on the parent (work belongs on the vials). Opt-in via a checkbox in
  // the Manage Analyses overlay. Ephemeral on purpose — resets to hidden on
  // every page load so the deterrent always applies to a fresh visit.
  const [showParentResultEditing, setShowParentResultEditing] = useState(false)
  const [vialsQuickLookOpen, setVialsQuickLookOpen] = useState(false)
  // Parent pages: pick a vial's primary photo to attach to the parent AR
  const [selectVialImageOpen, setSelectVialImageOpen] = useState(false)
  // Parent pages: pick a vial's chromatogram to attach to the parent AR
  const [selectVialChromOpen, setSelectVialChromOpen] = useState(false)
  const [availableServices, setAvailableServices] = useState<AnalysisService[]>(
    []
  )
  const [servicesLoading, setServicesLoading] = useState(false)
  const [serviceSearch, setServiceSearch] = useState('')
  const [addingService, setAddingService] = useState<string | null>(null)
  const [removingKeyword, setRemovingKeyword] = useState<string | null>(null)
  // Retract-confirm modal for removing a service that has worked vial results.
  const [removalModal, setRemovalModal] = useState<{
    keyword: string
    title: string
    impact: RemovalImpact
  } | null>(null)
  // Replace-analyte dialog (wrong-variant correction), per slot.
  const [replaceSlot, setReplaceSlot] = useState<{
    slot: number
    oldPeptideId: number | null
    oldPeptideName: string
  } | null>(null)
  // Hide HPLC identity/purity/quantity from Manage Analyses (managed via Replace).
  // Default on — manual add/remove of these leaves the slot + vials out of sync.
  const [hideHplcServices, setHideHplcServices] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem('accu_mk1_manage_hide_hplc') !== 'false'
  })
  useEffect(() => {
    window.localStorage.setItem(
      'accu_mk1_manage_hide_hplc',
      String(hideHplcServices)
    )
  }, [hideHplcServices])

  const analysisSla = useAnalysisSlaMap(data)

  // Worksheet membership for the header link. Reuses the worksheets list
  // (react-query-cached); finds the worksheet whose items include this sample.
  // Matches the sample's own id, so it works on parent + sub-sample pages.
  const { data: allWorksheets = [] } = useQuery({
    queryKey: ['worksheets-list', undefined],
    queryFn: () => listWorksheets(),
    staleTime: 30_000,
  })
  const worksheetForSample = findWorksheetForSample(
    allWorksheets,
    data?.sample_id
  )

  // Customer link for the header: resolve the WC customer_id from this sample's
  // order (exact, keyed by the order id — the IS order endpoint already returns
  // customer_id). null for guest orders / missing order → plain text, no link.
  // SENAITE stores the order number with a "WP-" prefix (e.g. "WP-3242"), but
  // the IS order endpoint keys on the bare numeric id ("3242") — same
  // extraction the WC-admin link uses below. Strip to digits before resolving.
  const orderNumber = data?.client_order_number?.match(/\d+/)?.[0] ?? null
  const { data: linkedOrder } = useQuery({
    queryKey: ['explorer-order', orderNumber],
    queryFn: () => getExplorerOrderById(orderNumber as string),
    enabled: !!orderNumber,
    staleTime: 5 * 60 * 1000,
  })
  const customerLinkId = linkedOrder?.customer_id ?? null

  // Sub-samples — only meaningful for parent samples (sample IDs that don't end
  // in -SNN). Sub-samples don't have sub-sub-samples, so we hide the section
  // entirely on sub-sample detail pages.
  const isParent = !!sampleId && !/-S\d{2,}$/.test(sampleId)
  const [wizardParent, setWizardParent] = useState<ParentInfo | null>(null)
  const { data: subData, refetch: refetchSubs } = useQuery({
    queryKey: ['sub-samples', sampleId],
    queryFn: () => listSubSamples(sampleId ?? ''),
    enabled: !!sampleId && isParent,
  })
  const subSamples = subData?.sub_samples ?? []
  const subCount = subData?.parent.sub_sample_count ?? 0

  // Order scope for the Manage Sub-Samples overlay's Boxing tab. Mirrors
  // ActiveBoxesPage: fetch the order's samples in ANY review state (the
  // search can be fuzzy, so exact-match filter below) and share its
  // ['boxes-session-samples', key] cache. Runs only while the overlay is
  // open; order-less samples (or zero matches / errors) derive no boxing
  // prop, so the overlay keeps its current tab set.
  const boxingOrderKey = data?.client_order_number ?? null
  const { data: boxingSamplesData } = useQuery({
    queryKey: ['boxes-session-samples', boxingOrderKey],
    queryFn: () => getSenaiteSamples(undefined, 200, 0, boxingOrderKey!, 'order_number'),
    enabled: wizardParent !== null && boxingOrderKey !== null,
  })
  const boxingSamples = (boxingSamplesData?.items ?? []).filter(
    s => s.client_order_number === boxingOrderKey
  )
  // SenaiteLookupResult carries no client_id, so take it off the matched
  // order samples — same source groupSamplesByOrder uses for its groups.
  const wizardBoxing =
    boxingOrderKey !== null && boxingSamples.length > 0
      ? {
          orderKey: boxingOrderKey,
          orderLabel: boxingOrderKey,
          clientId: boxingSamples[0]?.client_id ?? null,
          sampleIds: boxingSamples.map(s => s.id),
        }
      : undefined

  // Parent linkage breadcrumb — only for sub-samples
  const parentSampleId = useMemo(() => {
    if (!sampleId) return null
    const m = sampleId.match(/^(.*)-S\d{2,}$/)
    return m ? m[1] : null
  }, [sampleId])

  // NOTE (container parents): the page keeps its FULL SENAITE bench surface
  // (result entry, submit/verify, bulk, corrections) — the lab still drives
  // the parent AR's SENAITE workflow from here, and parent-line retest
  // cascades to promoted source vials. The bench-hiding "report view" idea
  // was tried and walked back (2026-06-10); the hard lock on parent-row
  // writes ships with the SENAITE-elimination arc.

  const queryClient = useQueryClient()

  // Parent-page overlay: fan out each vial's Mk1 analyses so parent analysis
  // rows can show their assigned vial + Mk1 method/instrument/analyst.
  // Gated to parent pages (parentSampleId === null); sub-sample pages do their
  // own full Mk1 swap and never need this.
  // The parent-page gate (parentSampleId === null) is intentionally repeated on
  // each of overlayVials / enabled / the computed const below — each needs its
  // own guard, so don't "simplify" one away.
  const overlayVials =
    parentSampleId === null ? (subData?.sub_samples ?? []) : []
  const overlayAnalysesQueries = useQueries({
    queries: overlayVials.map(v => ({
      queryKey: [VIAL_OVERLAY_QUERY_KEY, v.id] as const,
      queryFn: () => listLimsAnalysesForSubSample(v.id),
      // Fetch every vial's Mk1 analyses. A vial's external_lims_uid is a SENAITE
      // hex when it was synced from SENAITE, yet it can still own lims_analyses
      // rows — so we must NOT gate on an 'mk1://' prefix. Vials with no Mk1 rows
      // return [] and simply contribute no matches.
      enabled: parentSampleId === null,
      staleTime: 30_000,
    })),
  })

  // Variance-set lock state for the overlay's vial chips: a Lock icon marks
  // vials locked into the set. Parent page only, and only when the family has a
  // variance vial (else skip the fetch). Source of truth for in_variance_set +
  // the set-level lock (listSubSamples carries neither).
  const _hasVarianceVial = overlayVials.some(
    v => v.assignment_kind === 'variance'
  )
  const { data: varianceSetOverlay } = useQuery({
    queryKey: ['variance-set-overlay', sampleId],
    queryFn: () => getVarianceSet(sampleId ?? ''),
    enabled: parentSampleId === null && _hasVarianceVial && !!sampleId,
    staleTime: 30_000,
  })
  const lockedVialIds = new Set(
    varianceSetOverlay?.locked
      ? varianceSetOverlay.vials
          .filter(v => v.in_variance_set)
          .map(v => v.sample_id)
      : []
  )

  // Ordered products for the sticky-header chip row (shares the card's query).
  const orderedProductsQuery = useOrderedProducts(sampleId ?? '')

  // Slot number → display peptide name (e.g. { 1: "BPC-157", 2: "TB-500" }).
  // Built here (pre-early-returns) because the overlay join's analyte bridge
  // needs it; also consumed by the analyte cards + AnalysisTable renames below.
  const analyteNameMap = new Map<number, string>()
  for (const analyte of data?.analytes ?? []) {
    const displayName =
      analyte.matched_peptide_name ??
      analyte.raw_name.replace(/\s*-\s*[^-]+\([^)]+\)\s*$/, '')
    analyteNameMap.set(analyte.slot_number, displayName)
  }

  // Parent-page only (memo would not help: useQueries' outer array churns each
  // render). The join is a cheap pure function.
  const vialAssignmentByKeyword =
    parentSampleId !== null || !data?.analyses
      ? undefined
      : buildVialAssignmentMap(
          data.analyses,
          overlayVials.map((v, i) => ({
            sampleId: v.sample_id,
            label: vialLabel(
              v.vial_sequence,
              subData?.parent.container_mode ?? false
            ),
            analyses: overlayAnalysesQueries[i]?.data ?? [],
            assignmentRole: v.assignment_role, // vial bench role
            assignmentKind: v.assignment_kind, // explicit variance bucket — drives overlay treatment
            varianceLocked: lockedVialIds.has(v.sample_id), // in the LOCKED variance set → Lock icon
          })),
          analyteNameMap // analyte bridge: ANALYTE-{n}-PUR/QTY ↔ PUR_/QTY_<X>
        )

  const { data: parentSummary } = useQuery({
    queryKey: ['sub-samples', parentSampleId],
    queryFn: () => listSubSamples(parentSampleId!),
    enabled: !!parentSampleId,
  })

  // Flag System (Plan 4): the entity this page's stateful flag button targets.
  // Parent pages flag the sample and aggregate their vials' flags
  // (includeDescendants); vial pages flag just this vial (its LimsSubSample pk).
  // The sample id is the human Sample ID — the backend registry resolves it.
  const flagEntityType = isParent ? 'sample' : 'sub_sample'
  const flagEntityId = isParent
    ? (data?.sample_id ?? '')
    : String(
        parentSummary?.sub_samples.find(s => s.sample_id === sampleId)?.id ?? ''
      )

  // Multi-flag affordances: while this page is mounted it is "the page you're
  // on" — the un-scoped flyout's Add Flag targets it. Human sample/vial id is
  // the label ("P-0144" / "P-0144-S01").
  useRegisterActiveFlagEntity(
    flagEntityId ? flagEntityType : null,
    flagEntityId || null,
    sampleId ?? null
  )

  // Vial-page Mk1 attachments: the check-in photo URL (also drives the header
  // thumb after edits) and the extra sample images. vialPhotoVersion bumps
  // force a refetch after replace/remove (the api.ts object-URL cache is
  // invalidated by those calls, so a bump means a real server round-trip).
  const [vialPhotoVersion, setVialPhotoVersion] = useState(0)
  const [vialPhotoUrl, setVialPhotoUrl] = useState<string | null>(null)
  const [vialAttachments, setVialAttachments] = useState<SubSampleAttachment[]>(
    []
  )
  // Chromatograms from vial-scoped HPLC preps. Vial pages: this vial's own
  // (rendered in the Attachments section). Parent pages: the whole family's
  // (feeds the Select Vial Chromatogram picker).
  const [vialChromatograms, setVialChromatograms] = useState<
    SubSampleChromatogram[]
  >([])

  useEffect(() => {
    if (!parentSampleId || !sampleId) {
      setVialPhotoUrl(null)
      setVialAttachments([])
      return
    }
    let cancelled = false
    fetchSubSamplePhotoUrl(sampleId)
      .then(u => {
        if (!cancelled) setVialPhotoUrl(u)
      })
      .catch(() => {
        if (!cancelled) setVialPhotoUrl(null)
      })
    listSubSampleAttachments(sampleId)
      .then(a => {
        if (!cancelled) setVialAttachments(a)
      })
      .catch(() => {
        if (!cancelled) setVialAttachments([])
      })
    return () => {
      cancelled = true
    }
  }, [parentSampleId, sampleId, vialPhotoVersion])

  // Both page kinds load chromatogram candidates from the same route (it
  // dispatches vial-vs-parent server-side). Best-effort — [] on failure.
  useEffect(() => {
    if (!sampleId) {
      setVialChromatograms([])
      return
    }
    let cancelled = false
    listSubSampleChromatograms(sampleId)
      .then(c => {
        if (!cancelled) setVialChromatograms(c)
      })
      .catch(() => {
        if (!cancelled) setVialChromatograms([])
      })
    return () => {
      cancelled = true
    }
  }, [sampleId, parentSampleId])

  const refreshVialPhoto = useCallback(() => {
    setVialPhotoVersion(v => v + 1)
    // photo_external_uid (read from the parent summary for hasPhoto / the
    // Remove-button gate) changed server-side — refetch the summary too.
    if (parentSampleId) {
      void queryClient.invalidateQueries({
        queryKey: ['sub-samples', parentSampleId],
      })
    }
  }, [parentSampleId, queryClient])

  const refreshVialAttachments = useCallback(() => {
    if (!sampleId) return
    listSubSampleAttachments(sampleId)
      .then(setVialAttachments)
      .catch(() => {})
  }, [sampleId])

  // The current vial's explicit assignment_kind ('core' | 'variance' | null).
  // Sub-sample pages read it from the parent's sub-samples summary; parent
  // pages have no kind (the parent is the canonical) → null. This replaces the
  // retired entitlement-based gating (useVarianceEntitlement) for row
  // affordances — entitlement is a display-only paid marker on AssignStep now.
  const currentVialKind =
    parentSampleId !== null
      ? (parentSummary?.sub_samples.find(s => s.sample_id === sampleId)
          ?.assignment_kind ?? null)
      : null

  // Phase senaite-writeback Task 4: fetch promotion provenance on parent pages.
  // Extracted into a callable so refreshSample can re-pull it after a QuickLook
  // promote (the badge would otherwise stay stale until a full page reload).
  const refreshPromotions = useCallback((id: string) => {
    listParentPromotions(id)
      .then(records => {
        setPromotionsByKeyword(new Map(records.map(r => [r.keyword, r])))
      })
      .catch(() => {
        // Non-fatal: badge simply won't appear if the fetch fails
      })
  }, [])

  // parentSampleId is null on parent pages (no -SNN suffix), so !parentSampleId
  // is the correct gate.
  useEffect(() => {
    if (!sampleId || parentSampleId !== null) return
    refreshPromotions(sampleId)
  }, [sampleId, parentSampleId, refreshPromotions])

  // Fetch parent AR analysis states for native sub-sample pages.
  // parentSampleId is non-null only when we are a sub-sample (have -SNN suffix).
  // Best-effort: catch → empty states, UI degrades gracefully (no locking).
  useEffect(() => {
    if (!parentSampleId) return
    listParentLineStates(parentSampleId)
      .then(({ states }) => setParentLineStates(states))
      .catch(() => setParentLineStates({}))
  }, [parentSampleId])

  // This vial's own record in the parent's sub-samples list (null on parent
  // pages or before the list loads). Shared by the header's role lookup,
  // vial-count line, and box chip.
  const meVial =
    parentSummary?.sub_samples.find(s => s.sample_id === sampleId) ?? null

  // Resolve this sample's vial-assignment role for the header label.
  // Parent pages: pull from lims_samples.assignment_role (defaults to 'hplc'
  // per migration; can change after AssignStep moves the parent into another
  // bucket). Sub-sample pages: look up in the parent's sub-samples list which
  // carries assignment_role on each entry.
  const currentAssignment: string | null = isParent
    ? subData?.parent.container_mode
      ? // Container parent: a pure report depository — it has no bench role,
        // so no "Assigned to" line / role badge (its vials carry the roles).
        null
      : (subData?.parent.assignment_role ?? 'hplc')
    : (meVial?.assignment_role ?? null)
  const assignmentLabel = (() => {
    switch (currentAssignment) {
      case 'hplc':
        return 'Analytical HPLC'
      case 'endo':
        return 'Microbiology — Endotoxin'
      case 'ster':
        return 'Microbiology — Sterility'
      case 'xtra':
        return 'Extra (unassigned)'
      default:
        return null
    }
  })()

  const primaryAnalysisUids = useMemo(
    () => computePrimaryAnalysisUids(data?.analyses ?? [], currentAssignment),
    [data, currentAssignment]
  )

  async function openSubSampleWizard() {
    // On a parent page, open the wizard for the current sample.
    // On a sub-sample page, open it for the parent. The parent summary
    // returned by listSubSamples only carries external_lims_uid when the
    // parent has been previously cached in lims_samples (i.e. someone
    // created a sub-sample for it). For a fresh parent we fall back to
    // a direct SENAITE lookup to get the UID.
    if (isParent) {
      if (!data?.sample_id || !data.sample_uid) return
      setWizardParent({
        uid: data.sample_uid,
        sample_id: data.sample_id,
        status: data.review_state,
      })
      return
    }

    if (!parentSampleId) return
    const cached = parentSummary?.parent
    if (cached?.external_lims_uid) {
      setWizardParent({
        uid: cached.external_lims_uid,
        sample_id: cached.sample_id,
        status: cached.status ?? null,
      })
      return
    }

    // Cold-cache path — fetch parent metadata from SENAITE on demand.
    try {
      const parentLookup = await lookupSenaiteSample(parentSampleId)
      if (!parentLookup.sample_uid) {
        toast.error('Parent sample not found in SENAITE')
        return
      }
      setWizardParent({
        uid: parentLookup.sample_uid,
        sample_id: parentLookup.sample_id,
        status: parentLookup.review_state,
      })
    } catch (e) {
      toast.error('Could not load parent sample', {
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  async function openHplcResults() {
    if (!sampleId) return
    try {
      const preps = await listSamplePreps({ search: sampleId, limit: 1 })
      if (preps.length === 0) {
        toast.error('No sample prep found for this sample')
        return
      }
      const prep = preps[0]!
      setHplcFlyoutMatch({
        prep_id: prep.id,
        senaite_sample_id: prep.senaite_sample_id ?? prep.sample_id,
        folder_name: prep.senaite_sample_id ?? prep.sample_id,
        folder_id: '',
        peak_files: [],
        chrom_files: [],
      })
      setHplcFlyoutPrep(prep)
    } catch {
      toast.error('Failed to load sample prep')
    }
  }

  const openManageAnalyses = async () => {
    setManageAnalysesOpen(true)
    if (availableServices.length === 0) {
      setServicesLoading(true)
      try {
        const services = await listAnalysisServices()
        setAvailableServices(services)
      } catch {
        toast.error('Failed to load analysis services')
      } finally {
        setServicesLoading(false)
      }
    }
  }

  const handleAddAnalysis = async (service: AnalysisService) => {
    if (!data?.sample_id) return
    setAddingService(service.uid)
    try {
      await addAnalysisToSample(data.sample_id, service.uid)
      toast.success(`Added ${service.title}`)
      refreshSample(data.sample_id)
    } catch (e) {
      toast.error('Failed to add analysis', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setAddingService(null)
    }
  }

  // Trash-icon click: check what the removal would touch. Pristine-only →
  // remove straight away (today's behavior). Worked/blocked vial rows →
  // open the retract-confirm modal first.
  const handleRemoveAnalysis = async (keyword: string, title: string) => {
    if (!data?.sample_id) return
    setRemovingKeyword(keyword)
    try {
      const impact = await getRemovalImpact(data.sample_id, keyword)
      if (impact.blocked.length > 0 || impact.worked_unverified.length > 0) {
        setRemovalModal({ keyword, title, impact })
        return
      }
      await performRemoveAnalysis(keyword, title, false)
    } catch (e) {
      toast.error('Failed to remove analysis', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setRemovingKeyword(null)
    }
  }

  const performRemoveAnalysis = async (
    keyword: string,
    title: string,
    confirmRetract: boolean
  ) => {
    if (!data?.sample_id) return
    setRemovingKeyword(keyword)
    try {
      await removeAnalysisFromSample(data.sample_id, keyword, {
        confirmRetract,
      })
      toast.success(`Removed ${title}`)
      setRemovalModal(null)
      refreshSample(data.sample_id)
    } catch (e) {
      toast.error('Failed to remove analysis', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setRemovingKeyword(null)
    }
  }

  /**
   * Native-aware sample loader shared by the initial load, the Retry handler,
   * and the silent post-transition refresh. A Model-D native vial (mk1:// uid)
   * has no SENAITE AR, so it loads entirely from Mk1 and never calls SENAITE —
   * without this, every transition's refresh 404s. Parent samples and legacy
   * SENAITE-backed vials use the SENAITE lookup as before. If the Mk1 sub-sample
   * lookup fails, falls through to SENAITE so legacy vials still load.
   */
  const resolveSampleData = useCallback(
    async (id: string): Promise<SenaiteLookupResult> => {
      const parentId = id.match(/^(.*)-S\d{2,}$/)?.[1]
      if (parentId) {
        try {
          const list = await listSubSamples(parentId)
          const me = list.sub_samples.find(s => s.sample_id === id)
          if (me?.external_lims_uid?.startsWith('mk1://')) {
            const mk1Analyses = await listLimsAnalysesForSubSample(me.id)
            return {
              ...buildNativeSubSampleLookup(me, list.parent),
              analyses: mk1Analyses,
            }
          }
        } catch (e) {
          // Mk1 lookup failed — fall through to the SENAITE lookup (legacy path).
          console.warn(`[sample-details] Mk1 native lookup failed for ${id}; falling back to SENAITE`, e)
        }
      }
      // This return is shared by the parent branch and the legacy sub-sample
      // fallthrough above (parentId set but not mk1://-native, or the Mk1
      // lookup threw) — only route the parent read through the toggle so
      // sub-sample behavior stays untouched regardless of readSource.
      return lookupSenaiteSample(id, true, parentId === undefined ? effectiveReadSource : 'senaite')
    },
    [effectiveReadSource]
  )

  const fetchSample = (id: string) => {
    setLoading(true)
    setError(null)

    resolveSampleData(id)
      .then(result => setData(result))
      .catch(e =>
        setError(e instanceof Error ? e.message : 'Failed to load sample')
      )
      .finally(() => setLoading(false))
  }

  /** Silent re-fetch: updates data without triggering full-page loading state.
   *  Refreshes all three parent-page surfaces a QuickLook mutation can touch —
   *  the AR rows (`data`), the per-vial overlay column, and the promotion badges
   *  — so a promote/transition/add/remove reflects immediately without a reload. */
  const refreshSample = (id: string) => {
    resolveSampleData(id)
      .then(result => setData(result))
      .catch(e =>
        toast.error('Refresh failed', {
          description: e instanceof Error ? e.message : String(e),
        })
      )
    // Overlay + promotion badges only exist on parent pages; skip on sub-samples.
    if (parentSampleId === null) {
      invalidateParentVialOverlay(queryClient)
      refreshPromotions(id)
    }
  }

  const openOrderFlyout = async () => {
    const orderId = data?.client_order_number?.match(/\d+/)?.[0]
    if (!orderId) return
    setWooOrderOpen(true)
    setWooOrderLoading(true)
    try {
      const order = await getWooOrder(orderId)
      setWooOrderData(order)
    } catch {
      toast.error('Failed to load order details')
      setWooOrderOpen(false)
    } finally {
      setWooOrderLoading(false)
    }
  }

  useEffect(() => {
    if (!sampleId) return
    let cancelled = false

    setLoading(true)
    setError(null)

    resolveSampleData(sampleId)
      .then(result => {
        if (!cancelled) setData(result)
      })
      .catch(e => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Failed to load sample')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [sampleId, resolveSampleData])

  // Phase 3 (mk1-native-analyses): for sub-samples, replace data.analyses
  // with the Mk1-sourced rows. AnalysisTable renders the same SenaiteAnalysis
  // shape; UIDs in the Mk1 rows carry an 'mk1:' prefix so the dispatch shims
  // in setAnalysisResult / transitionAnalysis route writes to the Mk1
  // endpoints. Parent samples are untouched — their analyses stay SENAITE.
  // Re-derived each render so the swap effect can self-heal: it re-runs
  // whenever the analyses revert to SENAITE-sourced (e.g. a refetch after a
  // result-entry transition reset them), and no-ops once they're Mk1-sourced.
  const analysesNeedMk1Swap = !!data && needsMk1AnalysesSwap(data.analyses)
  useEffect(() => {
    if (!parentSampleId || !sampleId || !data) return
    // Only swap while the analyses are still SENAITE-sourced. Once swapped,
    // every row is mk1:-prefixed so this is false and the effect no-ops —
    // which is why analysesNeedMk1Swap is a safe (non-looping) dependency.
    if (!analysesNeedMk1Swap) return
    let cancelled = false
    ;(async () => {
      try {
        const subs = await listSubSamples(parentSampleId)
        const me = subs.sub_samples.find(s => s.sample_id === sampleId)
        if (!me) return
        const mk1Analyses = await listLimsAnalysesForSubSample(me.id)
        if (cancelled) return
        setData(prev => (prev ? { ...prev, analyses: mk1Analyses } : prev))
      } catch (e) {
        // Best-effort: leave SENAITE-sourced analyses in place on failure.
        console.error(
          'Phase 3: failed to load Mk1 analyses for sub-sample',
          sampleId,
          e
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [parentSampleId, sampleId, data?.sample_uid, analysesNeedMk1Swap])

  // Fetch additional COAs from integration service
  useEffect(() => {
    if (!sampleId) return
    let cancelled = false

    getSampleAdditionalCOAs(sampleId).then(configs => {
      if (!cancelled) {
        setAdditionalCoas(configs)
        setAdditionalCoaPage(0)
      }
    })

    return () => {
      cancelled = true
    }
  }, [sampleId])

  // Fetch peptide catalog + per-sample alias picks (drives the COA display-alias dropdown)
  useEffect(() => {
    if (!sampleId) return
    let cancelled = false

    Promise.all([getPeptides(), getSampleAnalyteAliases(sampleId)])
      .then(([peptides, aliases]) => {
        if (cancelled) return
        setPeptidesCatalog(peptides)
        const m = new Map<number, string>()
        for (const a of aliases) m.set(a.slot, a.alias)
        setSampleAliases(m)
      })
      .catch(e => {
        // Non-fatal — alias picker just falls back to empty options
        console.warn('Failed to load peptide aliases', e)
      })

    return () => {
      cancelled = true
    }
  }, [sampleId])

  // Fetch COA generations to determine publish availability
  useEffect(() => {
    if (!sampleId) return
    let cancelled = false

    // Fetch generously: the explorer orders primaries first (parent_generation_id
    // IS NULL), so a sample with many primary regens would push its CHILD COAs
    // (per-vial + the regular parent-services COA) past a small limit. 50 keeps
    // the current children on the page for realistic regen counts.
    getExplorerCOAGenerations(sampleId, 50)
      .then(gens => {
        if (!cancelled) setCoaGenerations(gens)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [sampleId])

  // Fetch retest relationship metadata (drives the retest banner + chain pills)
  useEffect(() => {
    if (!sampleId) {
      setRetestInfo(null)
      return
    }
    let cancelled = false

    import('@/lib/api')
      .then(({ getSampleRetestInfo }) => getSampleRetestInfo(sampleId))
      .then(info => {
        if (!cancelled) setRetestInfo(info)
      })
      .catch(() => {
        if (!cancelled) setRetestInfo(null)
      })

    return () => {
      cancelled = true
    }
  }, [sampleId])

  if (!sampleId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        No sample selected
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Loading sample {sampleId}...
        </p>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 h-full text-muted-foreground">
        <XCircle className="h-8 w-8" />
        <p className="text-sm">{error ?? 'Sample not found'}</p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 cursor-pointer"
            onClick={() => fetchSample(sampleId)}
          >
            <RefreshCw size={14} />
            Retry
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="cursor-pointer"
            onClick={() => navigateTo('senaite', 'samples')}
          >
            Back to Samples
          </Button>
        </div>
      </div>
    )
  }

  const hasDraftCOA = coaGenerations.some(g => g.status === 'draft')

  /** Kicks off the animated console and returns a `resolve(ok, errMsg?)` function. */
  const startCOAConsole = (title: string, stepDefs: StepDef[]) => {
    // Clear any pending timers from a previous run
    consoleTimers.current.forEach(clearTimeout)
    consoleTimers.current = []

    const initial: ConsoleStep[] = stepDefs.map(s => ({
      id: s.id,
      label: s.label,
      status: 'waiting',
    }))
    setCoaConsole({ visible: true, title, steps: initial, phase: 'running' })

    // Schedule each step becoming 'running' (and the previous one 'ok')
    stepDefs.forEach((def, idx) => {
      const t = setTimeout(() => {
        setCoaConsole(prev => ({
          ...prev,
          steps: prev.steps.map((s, i) => {
            if (i === idx) return { ...s, status: 'running' }
            if (i === idx - 1 && s.status === 'running')
              return { ...s, status: 'ok' }
            return s
          }),
        }))
      }, def.delay)
      consoleTimers.current.push(t)
    })

    // Returns a settle function — call when the API resolves
    return (success: boolean, errorDetail?: string) => {
      consoleTimers.current.forEach(clearTimeout)
      consoleTimers.current = []

      if (success) {
        setCoaConsole(prev => ({
          ...prev,
          phase: 'done',
          steps: prev.steps.map(s => ({
            ...s,
            status: s.status === 'error' ? 'error' : 'ok',
          })),
        }))
        // Auto-dismiss after 4s on success
        const t = setTimeout(
          () => setCoaConsole(prev => ({ ...prev, visible: false })),
          4000
        )
        consoleTimers.current.push(t)
      } else {
        setCoaConsole(prev => {
          // Try to infer the actual failing step from the error message
          const inferredIdx = inferErrorStepIdx(errorDetail, prev.steps)

          if (inferredIdx >= 0) {
            // Paint steps before the failure as OK, the failure step as ERR,
            // and steps after as waiting (they never ran)
            return {
              ...prev,
              phase: 'error',
              errorDetail,
              steps: prev.steps.map((s, i) => {
                if (i < inferredIdx) return { ...s, status: 'ok' }
                if (i === inferredIdx) return { ...s, status: 'error' }
                return { ...s, status: 'waiting' }
              }),
            }
          }

          // Fallback: mark the running step as error; if none is running,
          // mark the last non-waiting step so something always turns red
          const hasRunning = prev.steps.some(s => s.status === 'running')
          let lastActiveIdx = -1
          if (!hasRunning) {
            prev.steps.forEach((s, i) => {
              if (s.status !== 'waiting') lastActiveIdx = i
            })
          }
          return {
            ...prev,
            phase: 'error',
            errorDetail,
            steps: prev.steps.map((s, i) => {
              if (s.status === 'running') return { ...s, status: 'error' }
              if (!hasRunning && i === lastActiveIdx)
                return { ...s, status: 'error' }
              return s
            }),
          }
        })
      }
    }
  }

  const handleGenerateCOA = async () => {
    setIsGeneratingCOA(true)
    const settle = startCOAConsole(`generate-coa ${sampleId}`, GENERATE_STEPS)
    try {
      const result = await generateSenaiteCOA(sampleId)
      if (result.success) {
        settle(true)
        if (result.verification_code) {
          setData(prev =>
            prev
              ? {
                  ...prev,
                  coa: {
                    ...prev.coa,
                    verification_code: result.verification_code,
                  },
                }
              : prev
          )
        }
        refreshSample(sampleId)
        getExplorerCOAGenerations(sampleId, 50)
          .then(setCoaGenerations)
          .catch(() => {})
        getSampleAdditionalCOAs(sampleId)
          .then(setAdditionalCoas)
          .catch(() => {})
      } else {
        settle(false, result.message ?? 'Generation failed')
        toast.error('COA generation failed', { description: result.message })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      settle(false, msg)
      toast.error('COA generation failed', { description: msg })
    } finally {
      setIsGeneratingCOA(false)
    }
  }

  const handleGenerateVialCOAs = async () => {
    const primaryGen = coaGenerations.find(
      g => g.parent_generation_id == null && g.status !== 'superseded'
    )
    if (!primaryGen) {
      toast.error('Generate the parent COA first', {
        description:
          'Per-vial COAs attach to the parent COA, which must exist before spinning off vials.',
      })
      return
    }
    setIsGeneratingVialCOAs(true)
    const settle = startCOAConsole(
      `generate-vial-coas ${sampleId}`,
      GENERATE_STEPS
    )
    try {
      const result = await generateVialCOAs(sampleId)
      if (result.success) {
        settle(true)
        toast.success('Per-vial COAs', { description: result.message })
        refreshSample(sampleId)
        getExplorerCOAGenerations(sampleId, 50)
          .then(setCoaGenerations)
          .catch(() => {})
        getSampleAdditionalCOAs(sampleId)
          .then(setAdditionalCoas)
          .catch(() => {})
      } else {
        settle(false, result.message ?? 'Vial COA generation failed')
        toast.error('Per-vial COA generation failed', {
          description: result.message,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      settle(false, msg)
      toast.error('Per-vial COA generation failed', { description: msg })
    } finally {
      setIsGeneratingVialCOAs(false)
    }
  }

  const handlePublishCOA = async () => {
    setIsPublishingCOA(true)
    const settle = startCOAConsole(`publish-coa ${sampleId}`, PUBLISH_STEPS)
    try {
      const result = await publishSenaiteCOA(sampleId)
      if (result.success) {
        settle(true)
        if (result.warning) {
          toast.warning('COA published with warning', {
            description: result.warning,
          })
        }
        refreshSample(sampleId)
        getExplorerCOAGenerations(sampleId, 50)
          .then(setCoaGenerations)
          .catch(() => {})
      } else {
        settle(false, result.message ?? 'Publish failed')
        toast.error('COA publish failed', { description: result.message })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      settle(false, msg)
      toast.error('COA publish failed', { description: msg })
    } finally {
      setIsPublishingCOA(false)
    }
  }

  const analyses = data.analyses ?? []
  // Header counters + progress exclude dead analyses (rejected/retracted/
  // cancelled/invalid) — a rejected test was taken off the offering, so it
  // isn't part of "X of N verified". The analyses table still renders them.
  const countableAnalyses = analyses.filter(
    a =>
      !['rejected', 'retracted', 'cancelled', 'invalid'].includes(
        a.review_state ?? ''
      )
  )
  const countableTotal = countableAnalyses.length
  const verifiedCount = countableAnalyses.filter(
    a => a.review_state === 'verified' || a.review_state === 'published'
  ).length
  const pendingCount = countableTotal - verifiedCount

  // Per-product completion (green check + contributing vials), from data the
  // page already loads. Shared by the card chips and the sticky-header chips.
  const productCompletionCtx: ProductCompletionContext = {
    analyses: data.analyses,
    promotionsByKeyword,
    varianceSet: varianceSetOverlay,
  }

  const senaiteBaseUrl = getSenaiteUrl()

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      {/* Breadcrumb — scrolls away with the page */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => navigateTo('senaite', 'samples')}
          >
            <ArrowLeft size={14} />
            Samples
          </Button>
          <ChevronRight size={12} className="text-muted-foreground" />
          <span className="text-sm font-medium">{data.sample_id}</span>
        </div>
      </div>

      {/* Sticky header band — bleeds to container edges with -mx-6 px-6 */}
      <div className="sticky -top-4 z-20 -mx-6 px-6 pt-4 pb-4 mb-6 backdrop-blur-md bg-background/85 border-b border-border/30 shadow-sm">
        {/* Retest banner — prominent strip when this sample IS a retest */}
        {retestInfo?.is_retest && retestInfo.source_sample_id && (
          <div className="mb-3 rounded-md border border-violet-500/40 bg-violet-500/10 dark:bg-violet-500/15 px-3 py-2 flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-violet-700 dark:text-violet-300">
              <RefreshCw size={13} /> Retest
            </span>
            <span className="text-sm text-foreground">
              of{' '}
              <button
                type="button"
                onClick={() => navigateToSample(retestInfo.source_sample_id!)}
                className="font-mono font-semibold text-violet-700 dark:text-violet-300 hover:underline underline-offset-2"
              >
                {retestInfo.source_sample_id}
              </button>
            </span>
            {retestInfo.this_order_id && (
              <span className="text-xs text-muted-foreground">
                · WP order #{retestInfo.this_order_id}
              </span>
            )}
            {retestInfo.retest_created_at && (
              <span className="text-xs text-muted-foreground">
                · {formatDate(retestInfo.retest_created_at)}
              </span>
            )}
          </div>
        )}

        {/* Sample ID + counters + progress */}
        <div className="flex items-start justify-between gap-x-4 gap-y-2 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-violet-600/20 to-violet-500/5 border border-violet-500/30 dark:border-violet-500/20">
              <FlaskConical
                size={20}
                className="text-violet-600 dark:text-violet-400"
              />
            </div>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-bold tracking-tight font-mono">
                  {data.senaite_url ? (
                    <a
                      href={
                        data.senaite_url.startsWith('http')
                          ? data.senaite_url
                          : `${senaiteBaseUrl}${data.senaite_url}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-blue-700 dark:hover:text-blue-400 transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      {data.sample_id}
                      <ExternalLink
                        size={14}
                        className="text-muted-foreground"
                      />
                    </a>
                  ) : (
                    data.sample_id
                  )}
                </h1>
                {data.review_state && <StatusBadge state={data.review_state} />}
                {data.sample_type && (
                  <Badge
                    variant="outline"
                    className="bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-400 dark:border-violet-500/20"
                  >
                    {data.sample_type}
                  </Badge>
                )}
              </div>
              {!isParent && parentSampleId && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1 flex-wrap">
                  <CornerDownRight className="h-3.5 w-3.5 shrink-0" />
                  <span>Sub-sample of</span>
                  <button
                    type="button"
                    onClick={() => navigateToSample(parentSampleId)}
                    className="font-mono underline hover:text-foreground transition-colors cursor-pointer"
                  >
                    {parentSampleId}
                  </button>
                  {parentSummary &&
                    meVial &&
                    (() => {
                      // Mode-aware family numbering: legacy counts the parent
                      // as Vial 1; container families count physical vials only.
                      const cm = parentSummary.parent.container_mode ?? false
                      const total = vialTotal(
                        parentSummary.parent.sub_sample_count,
                        cm
                      )
                      return (
                        <>
                          <span aria-hidden>·</span>
                          <span>
                            Vial {vialPosition(meVial.vial_sequence, cm)} of{' '}
                            {total}
                          </span>
                        </>
                      )
                    })()}
                  {currentAssignment && (
                    <>
                      <span aria-hidden>·</span>
                      <RoleHeaderBadge role={currentAssignment} />
                    </>
                  )}
                  {meVial?.box_label && (
                    <>
                      <span aria-hidden>·</span>
                      <button
                        type="button"
                        onClick={() =>
                          useUIStore.getState().navigateToBoxes(meVial.box_label!)
                        }
                        title="View in Active Boxes"
                        className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted transition-colors"
                      >
                        <Box className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {meVial.box_label}
                      </button>
                    </>
                  )}
                </div>
              )}
              {isParent && subCount > 0 && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1 flex-wrap">
                  <Package className="h-3.5 w-3.5 shrink-0" />
                  <span>Parent Sample</span>
                  <span aria-hidden>·</span>
                  {/* Container parent is NOT a vial — show the family size. */}
                  <span>
                    {subData?.parent.container_mode
                      ? `${subCount} vial${subCount === 1 ? '' : 's'}`
                      : `Vial 1 of ${subCount + 1}`}
                  </span>
                  {currentAssignment && (
                    <>
                      <span aria-hidden>·</span>
                      <RoleHeaderBadge role={currentAssignment} />
                    </>
                  )}
                </div>
              )}
              <div className="text-xs text-muted-foreground mt-0.5">
                <p>
                  Received {formatDate(data.date_received)}
                  {' · '}Client:{' '}
                  {customerLinkId != null ? (
                    <button
                      type="button"
                      onClick={() =>
                        useUIStore.getState().navigateToCustomer(customerLinkId)
                      }
                      className="text-blue-700 underline-offset-2 hover:underline dark:text-blue-400"
                      title="View customer"
                    >
                      {data.client ?? '—'}
                    </button>
                  ) : (
                    <span className="text-foreground/80">
                      {data.client ?? '—'}
                    </span>
                  )}
                  {!retestInfo?.is_retest &&
                    retestInfo?.retested_as &&
                    retestInfo.retested_as.length > 0 && (
                      <>
                        {' · '}
                        <span className="text-violet-700 dark:text-violet-300">
                          ↳ Retested as:
                        </span>{' '}
                        {retestInfo.retested_as.map((r, i) => (
                          <span key={r.sample_id}>
                            {i > 0 && ', '}
                            <button
                              type="button"
                              onClick={() => navigateToSample(r.sample_id)}
                              className="font-mono font-semibold text-violet-700 dark:text-violet-300 hover:underline underline-offset-2"
                              title={
                                r.created_at
                                  ? `Created ${formatDate(r.created_at)}`
                                  : undefined
                              }
                            >
                              {r.sample_id}
                            </button>
                          </span>
                        ))}
                      </>
                    )}
                </p>
                <ReadSourceBanner
                  readSource={data.read_source}
                  registryMissing={data.registry_missing}
                  fieldSources={data.field_sources}
                />
              </div>
            </div>
          </div>

          {/* Worksheet membership — left of the counters; opens the worksheet flyout */}
          {worksheetForSample && (
            <button
              type="button"
              onClick={() =>
                useUIStore.getState().openWorksheetDrawer(worksheetForSample.id)
              }
              className="group flex flex-col items-center text-center"
              title={`Open worksheet: ${worksheetForSample.title}`}
            >
              <div className="max-w-[180px] truncate text-sm font-semibold text-violet-700 underline-offset-2 group-hover:underline dark:text-violet-300">
                {worksheetForSample.title}
              </div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Worksheet
              </div>
            </button>
          )}

          {/* Counters */}
          {countableTotal > 0 && (
            <div className="flex items-center gap-6 text-center">
              <div>
                <div className="text-lg font-bold text-emerald-700 dark:text-emerald-400">
                  {verifiedCount}
                </div>
                <div className="text-[11px] text-muted-foreground uppercase tracking-wider">
                  Verified
                </div>
              </div>
              <div className="w-px h-8 bg-border" />
              <div>
                <div className="text-lg font-bold text-amber-600 dark:text-amber-400">
                  {pendingCount}
                </div>
                <div className="text-[11px] text-muted-foreground uppercase tracking-wider">
                  Pending
                </div>
              </div>
              <div className="w-px h-8 bg-border" />
              <div>
                <div className="text-lg font-bold text-foreground">
                  {countableTotal}
                </div>
                <div className="text-[11px] text-muted-foreground uppercase tracking-wider">
                  Total
                </div>
              </div>
            </div>
          )}

          {/* Flag System (Plan 4): stateful flag button, right-aligned (ml-auto)
              so it sits next to the thumbnail in the justify-between row. Parent
              pages aggregate their vials' flags; vial pages flag just this vial. */}
          {flagEntityId && (
            <div className="flex items-start ml-auto">
              <EntityFlagButton
                entityType={flagEntityType}
                entityId={flagEntityId}
                includeDescendants={isParent}
                size="lg"
              />
            </div>
          )}

          {/* Vial photo — far right of the top row, hover to enlarge.
              Vial pages: photo presence comes from the parent summary's vial
              record. Parent pages: the parent IS vial 1, and the photo endpoint
              falls back to the parent AR's last attachment for non-sub-sample
              IDs (see VialsList.tsx), so we fetch optimistically. Either way,
              hideWhenEmpty keeps photo-less samples from rendering the "no
              photo" box — illegible at w-11 and wasted header space. */}
          {data.sample_id &&
            (() => {
              const me = parentSampleId
                ? parentSummary?.sub_samples.find(s => s.sample_id === sampleId)
                : null
              // Vial pages skip the fetch entirely when the vial record says
              // there's no photo; parent pages always try (404 → hidden).
              // vialPhotoUrl covers photos added/changed from the Attachments
              // section this session (the summary record may be momentarily
              // stale); the version key re-mounts the thumb so it refetches.
              const hasPhoto = parentSampleId
                ? !!me?.photo_external_uid || !!vialPhotoUrl
                : true
              return (
                <VialPhotoThumb
                  key={vialPhotoVersion}
                  sampleId={data.sample_id}
                  hasPhoto={hasPhoto}
                  // self-stretch: span the full height of the header's top row
                  sizeClass="self-stretch w-24 min-h-16"
                  hoverZoom
                  hideWhenEmpty
                />
              )
            })()}

          {/* Ordered-product chips — own line, right-aligned, directly above the
              action bar. overflow-x so a long set scrolls instead of wrapping. */}
          {(orderedProductsQuery.data?.products?.length ?? 0) > 0 && (
            <div className="w-full flex justify-end">
              <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto">
                {orderedProductsQuery.data!.products.map(p => (
                  <ProductChip
                    key={p.key}
                    compact
                    product={p}
                    completion={computeProductCompletion(
                      p,
                      productCompletionCtx
                    )}
                  />
                ))}
              </div>
            </div>
          )}

          {/* SLA + actions row — w-full wraps below the top row. The SLA
              lines (moved out of the left block) sit on the left, indented
              to align under the header text; the action buttons take the
              remaining width, which is enough for a single line. Stays in
              the sticky band so the actions are available while scrolling. */}
          <div className="w-full flex items-end justify-between gap-3">
            <div className="text-xs text-muted-foreground pl-[3.75rem] shrink-0">
              {/* SLA — stacked one indicator per line so multi-tier samples
                don't run a long inline string. */}
              <SampleHeaderSla lookup={data} />
            </div>
            <div className="flex items-center justify-end gap-1 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 gap-1 cursor-pointer"
                onClick={openHplcResults}
              >
                <Microscope size={12} />
                HPLC Results
              </Button>
              {/* Sub-sample pages only: jump straight into a new HPLC analysis
                (sample prep) for THIS vial — pre-fills the vial Sample ID and
                auto-fires the SENAITE lookup. Reset the wizard first so a
                half-finished session doesn't show its summary instead. */}
              {parentSampleId !== null && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 gap-1 cursor-pointer"
                  onClick={() => {
                    useWizardStore.getState().resetWizard()
                    useUIStore.getState().startPrepFromWorksheet({
                      sampleId: sampleId!,
                      peptideId: null,
                      method: null,
                      instrumentId: null,
                      autoLookup: true,
                    })
                  }}
                >
                  <FlaskConical size={12} />
                  New Analysis
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 gap-1 cursor-pointer"
                onClick={() => setActivityLogOpen(true)}
              >
                <ScrollText size={12} />
                Activity
              </Button>
              {isAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 px-0 cursor-pointer"
                  title="Registry debug (admin)"
                  onClick={() => setRegistryDebugOpen(true)}
                >
                  <Radar size={12} />
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 gap-1 cursor-pointer"
                onClick={openSubSampleWizard}
                disabled={isParent ? !data?.sample_uid : !parentSampleId}
              >
                <Plus size={12} />
                Manage Sub-Samples
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 gap-1 cursor-pointer"
                onClick={() =>
                  printLabel({
                    sampleId: sampleId!,
                    orderNumber: data?.client_order_number ?? null,
                    receivedAt: data?.date_received ?? null,
                  })
                }
              >
                <Printer size={13} />
                Print Label
              </Button>
              {isParent && subCount >= 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 gap-1 cursor-pointer"
                  onClick={() => setVarianceSummaryOpen(true)}
                >
                  <Sigma size={12} />
                  Variance Summary
                </Button>
              )}
              {/* COA actions (Generate / Publish) are parent-level — the certified
                deliverable lives on the parent AR, where the per-vial results are
                aggregated. Hidden on sub-samples so a per-vial generate can't
                fetch the empty vial and fail the conformance gate. */}
              {isParent && (
                <>
                  <div className="relative">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 gap-1 cursor-pointer"
                          disabled={
                            isGeneratingCOA ||
                            isPublishingCOA ||
                            isGeneratingVialCOAs
                          }
                        >
                          {isGeneratingCOA ||
                          isPublishingCOA ||
                          isGeneratingVialCOAs ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <ChevronDown size={12} />
                          )}
                          Actions
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem
                          onClick={handleGenerateCOA}
                          disabled={isGeneratingCOA}
                          className="cursor-pointer"
                        >
                          Generate Accumark COA
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={handleGenerateVialCOAs}
                          disabled={
                            isGeneratingVialCOAs ||
                            !coaGenerations.some(
                              g =>
                                g.parent_generation_id == null &&
                                g.status !== 'superseded'
                            )
                          }
                          className="cursor-pointer"
                        >
                          Generate Per-Vial COAs
                        </DropdownMenuItem>
                        {isParent && (
                          <DropdownMenuItem
                            onClick={handlePublishCOA}
                            disabled={isPublishingCOA || !hasDraftCOA}
                            className="cursor-pointer"
                          >
                            Publish Accumark COA
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <COAConsole
                      state={coaConsole}
                      onClose={() =>
                        setCoaConsole(prev => ({ ...prev, visible: false }))
                      }
                    />
                  </div>
                  {/* Console re-open button — only visible after an operation has run */}
                  {coaConsole.title && !coaConsole.visible && (
                    <button
                      onClick={() =>
                        setCoaConsole(prev => ({ ...prev, visible: true }))
                      }
                      className={cn(
                        'flex items-center justify-center w-7 h-7 rounded-md border transition-colors cursor-pointer',
                        coaConsole.phase === 'error'
                          ? 'border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20'
                          : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20'
                      )}
                      title="Show last operation log"
                    >
                      <Terminal size={12} />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
          {/* end: SLA + actions row */}

          {/* Progress bar + legend — w-full forces wrap to bottom row */}
          {countableTotal > 0 && (
            <div className="w-full space-y-1.5">
              <div className="h-1.5 bg-muted/60 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500/70 rounded-full transition-all duration-700"
                  style={{
                    width: `${(verifiedCount / countableTotal) * 100}%`,
                  }}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-muted-foreground">
                  {assignmentLabel ? (
                    <>
                      <span className="uppercase tracking-wider text-[11px]">
                        Assigned to
                      </span>
                      <span
                        className={`text-sm font-semibold ${
                          {
                            // Matches PRIMARY_TITLE_COLOR role tints in AnalysisTable
                            hplc: 'text-sky-700 dark:text-sky-300',
                            endo: 'text-emerald-700 dark:text-emerald-300',
                            ster: 'text-violet-700 dark:text-violet-300',
                            xtra: 'text-zinc-700 dark:text-zinc-300',
                          }[currentAssignment ?? ''] ?? 'text-foreground'
                        }`}
                      >
                        {assignmentLabel}
                      </span>
                    </>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-muted-foreground">
                    <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                      {Math.round((verifiedCount / countableTotal) * 100)}%
                    </span>{' '}
                    complete
                  </span>
                  <span className="text-border">·</span>
                  <span className="text-muted-foreground">
                    <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                      {verifiedCount}
                    </span>
                    /{countableTotal}{' '}
                    <span
                      className={
                        pendingCount > 0
                          ? 'text-amber-600 dark:text-amber-400'
                          : ''
                      }
                    >
                      verified
                    </span>
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
        {/* end: sample ID + counters + progress */}
      </div>
      {/* end: sticky header band */}

      {/* Main Grid: 2-column layout — metadata left, analytes right.
            Hidden on sub-sample pages: these are parent-level sections
            (sample/order/COA metadata + analytes live on the parent AR). */}
      {parentSampleId === null && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Left column: Sample Info + Order Details stacked */}
          <div className="space-y-4">
            <Card className="p-4">
              <SectionHeader icon={Package} title="Sample Info">
                <div className="space-y-0">
                  <DataRow
                    label="Sample Type"
                    value={data.sample_type}
                    emphasis
                  />
                  <EditableDataRow
                    label="Date Sampled"
                    value={data.date_sampled}
                    senaiteField="DateSampled"
                    sampleUid={data.sample_uid ?? ''}
                    formatDisplay={v => formatDate(v as string)}
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? { ...prev, date_sampled: v as string | null }
                          : prev
                      )
                    }
                  />
                  <DataRow
                    label="Date Received"
                    value={formatDate(data.date_received)}
                  />
                </div>
              </SectionHeader>
            </Card>

            <Card className="p-4">
              <SectionHeader icon={Hash} title="Order Details">
                <div className="space-y-0">
                  <div className="border-b border-border/50">
                    <div className="[&>div]:border-0 [&>div]:pb-0">
                      <EditableDataRow
                        label="Order #"
                        value={data.client_order_number}
                        senaiteField="ClientOrderNumber"
                        sampleUid={data.sample_uid ?? ''}
                        mono
                        emphasis
                        onSaved={v =>
                          setData(prev =>
                            prev
                              ? {
                                  ...prev,
                                  client_order_number: v as string | null,
                                }
                              : prev
                          )
                        }
                      />
                    </div>
                    {data.client_order_number &&
                      /\d+/.test(data.client_order_number) && (
                        <div className="flex items-center justify-end gap-3 pb-1">
                          <button
                            type="button"
                            onClick={openOrderFlyout}
                            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                          >
                            <Layers size={10} />
                            View Order Details
                          </button>
                          <a
                            href={`${getWordpressUrl()}/wp-admin/admin.php?page=wc-orders&action=edit&id=${data.client_order_number.match(/\d+/)?.[0]}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-blue-500 transition-colors"
                          >
                            <ExternalLink size={10} />
                            View in WP Admin
                          </a>
                        </div>
                      )}
                  </div>
                  <EditableDataRow
                    label="Client Sample ID"
                    value={data.client_sample_id}
                    senaiteField="ClientSampleID"
                    sampleUid={data.sample_uid ?? ''}
                    mono
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? { ...prev, client_sample_id: v as string | null }
                          : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Client Lot"
                    value={data.client_lot}
                    senaiteField="ClientLot"
                    sampleUid={data.sample_uid ?? ''}
                    mono
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? { ...prev, client_lot: v as string | null }
                          : prev
                      )
                    }
                  />
                  <DataRow label="Contact" value={data.contact} />
                  <DataRow
                    label="Client"
                    value={
                      data.client ? (
                        <span className="text-blue-700 dark:text-blue-400 text-xs">
                          {data.client}
                        </span>
                      ) : (
                        '—'
                      )
                    }
                  />
                </div>
                <OrderedProducts
                  sampleId={sampleId ?? ''}
                  subData={subData}
                  completionCtx={productCompletionCtx}
                />
              </SectionHeader>
            </Card>

            <Card className="p-4">
              <SectionHeader icon={Shield} title="COA Info">
                <div className="space-y-0">
                  <EditableDataRow
                    label="Company"
                    value={data.coa.company_name}
                    senaiteField="CoaCompanyName"
                    sampleUid={data.sample_uid ?? ''}
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? {
                              ...prev,
                              coa: {
                                ...prev.coa,
                                company_name: v as string | null,
                              },
                            }
                          : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Website"
                    value={data.coa.website}
                    senaiteField="CoaWebsite"
                    sampleUid={data.sample_uid ?? ''}
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? {
                              ...prev,
                              coa: { ...prev.coa, website: v as string | null },
                            }
                          : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Email"
                    value={data.coa.email}
                    senaiteField="CoaEmail"
                    sampleUid={data.sample_uid ?? ''}
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? {
                              ...prev,
                              coa: { ...prev.coa, email: v as string | null },
                            }
                          : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Verification Code"
                    value={data.coa.verification_code}
                    senaiteField="VerificationCode"
                    sampleUid={data.sample_uid ?? ''}
                    mono
                    formatDisplay={v =>
                      v ? (
                        <a
                          href={accuverifyUrl(v as string)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono hover:underline"
                        >
                          {v}
                        </a>
                      ) : (
                        '—'
                      )
                    }
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? {
                              ...prev,
                              coa: {
                                ...prev.coa,
                                verification_code: v as string | null,
                              },
                            }
                          : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Address"
                    value={data.coa.address}
                    senaiteField="CoaAddress"
                    sampleUid={data.sample_uid ?? ''}
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? {
                              ...prev,
                              coa: { ...prev.coa, address: v as string | null },
                            }
                          : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Logo URL"
                    value={data.coa.company_logo_url}
                    senaiteField="CompanyLogoUrl"
                    sampleUid={data.sample_uid ?? ''}
                    truncateStart
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? {
                              ...prev,
                              coa: {
                                ...prev.coa,
                                company_logo_url: v as string | null,
                              },
                            }
                          : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Chromatograph BG"
                    value={data.coa.chromatograph_background_url}
                    senaiteField="ChromatographBackgroundUrl"
                    sampleUid={data.sample_uid ?? ''}
                    truncateStart
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? {
                              ...prev,
                              coa: {
                                ...prev.coa,
                                chromatograph_background_url: v as
                                  | string
                                  | null,
                              },
                            }
                          : prev
                      )
                    }
                  />
                  {(data.coa.company_logo_url ||
                    data.coa.chromatograph_background_url) && (
                    <div className="py-2 flex items-center gap-3 justify-end">
                      {data.coa.company_logo_url && (
                        <div className="flex flex-col items-center gap-1">
                          <div className="h-16 w-24 rounded border bg-white flex items-center justify-center overflow-hidden">
                            <img
                              src={data.coa.company_logo_url}
                              alt="Company logo"
                              className="max-h-full max-w-full object-contain"
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground">
                            Logo
                          </span>
                        </div>
                      )}
                      {data.coa.chromatograph_background_url && (
                        <div className="flex flex-col items-center gap-1">
                          <div className="h-16 w-24 rounded border bg-white flex items-center justify-center overflow-hidden">
                            <img
                              src={data.coa.chromatograph_background_url}
                              alt="Chromatograph background"
                              className="max-h-full max-w-full object-contain"
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground">
                            Chromatograph
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </SectionHeader>
            </Card>
          </div>

          {/* Right column: Generated COAs + Additional COAs + Analytes stacked */}
          <div className="space-y-4">
            {/* Generated COAs */}
            <Card className="p-4">
              <SectionHeader icon={FileText} title="Generated COAs">
                {data.published_coa ? (
                  <PublishedCOACard
                    coa={data.published_coa}
                    sampleId={data.sample_id}
                    verificationCode={data.coa.verification_code}
                    generation={
                      coaGenerations.find(
                        g =>
                          g.parent_generation_id == null &&
                          g.status !== 'superseded'
                      ) ?? null
                    }
                    onRefresh={() => {
                      refreshSample(sampleId)
                      getExplorerCOAGenerations(sampleId, 50)
                        .then(setCoaGenerations)
                        .catch(() => {})
                      getSampleAdditionalCOAs(sampleId)
                        .then(setAdditionalCoas)
                        .catch(() => {})
                    }}
                  />
                ) : (
                  (() => {
                    // No SENAITE-attached ARReport (e.g. dev stacks lack the
                    // prod-only @@accumark-attach-coa addon). Fall back to the
                    // root generations Integration Service already has.
                    const rootGens = selectRootGenerations(coaGenerations)
                    return rootGens.length > 0 ? (
                      <GeneratedCOAFallbackList
                        generations={rootGens}
                        sampleId={sampleId}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No COA generated yet
                      </p>
                    )
                  })()
                )}
              </SectionHeader>
            </Card>

            {/* Per-Vial COAs — children of the primary, one per HPLC vial.
                selectRootGenerations collapses these out of the card above, so
                they get their own section labeled "Vial N". */}
            {(() => {
              const vialGens = selectVialGenerations(coaGenerations)
              return vialGens.length > 0 ? (
                <Card className="p-4">
                  <SectionHeader
                    icon={FileText}
                    title={`Per-Vial COAs (${vialGens.length})`}
                  >
                    <VialCOAList generations={vialGens} />
                  </SectionHeader>
                </Card>
              ) : null
            })()}

            {/* Core COA — the plain parent-services COA generated alongside a
                variance primary. A child (parent_generation_id set) with no
                vial_sequence, so the root/vial cards above collapse it out; it
                gets its own card here. */}
            {(() => {
              const regularGens = selectRegularGenerations(coaGenerations)
              return regularGens.length > 0 ? (
                <Card className="p-4">
                  <SectionHeader icon={FileText} title="Core COA">
                    <GeneratedCOAFallbackList
                      generations={regularGens}
                      sampleId={sampleId}
                    />
                  </SectionHeader>
                </Card>
              ) : null
            })()}

            {/* Digital COA Badge Embed */}
            {data.coa.verification_code && (
              <Card className="p-4">
                <SectionHeader icon={ShieldCheck} title="Digital COA">
                  <AccuVerifyBadge code={data.coa.verification_code} />
                </SectionHeader>
              </Card>
            )}

            {/* Additional COAs from Integration Service */}
            {additionalCoas.length > 0 &&
              (() => {
                const PAGE_SIZE = 5
                const totalPages = Math.max(
                  1,
                  Math.ceil(additionalCoas.length / PAGE_SIZE)
                )
                const page = Math.min(additionalCoaPage, totalPages - 1)
                const pageStart = page * PAGE_SIZE
                const pageCoas = additionalCoas.slice(
                  pageStart,
                  pageStart + PAGE_SIZE
                )
                return (
                  <Card className="p-4">
                    <SectionHeader
                      icon={Copy}
                      title={`Additional COAs (${additionalCoas.length})`}
                    >
                      <div className="space-y-3">
                        {pageCoas.map(coa => (
                          <AdditionalCoaCard
                            key={coa.config_id}
                            coa={coa}
                            sampleId={data.sample_id}
                            onUpdateState={(field, newValue) =>
                              setAdditionalCoas(prev =>
                                prev.map(c =>
                                  c.config_id === coa.config_id
                                    ? {
                                        ...c,
                                        coa_info: {
                                          ...c.coa_info,
                                          [field]: newValue as string | null,
                                        },
                                      }
                                    : c
                                )
                              )
                            }
                            onRegenerated={() => {
                              getSampleAdditionalCOAs(data.sample_id)
                                .then(setAdditionalCoas)
                                .catch(() => {})
                              getExplorerCOAGenerations(data.sample_id, 50)
                                .then(setCoaGenerations)
                                .catch(() => {})
                            }}
                          />
                        ))}
                      </div>
                      {totalPages > 1 && (
                        <div className="flex items-center justify-between pt-3 mt-1 border-t border-border/40">
                          <button
                            onClick={() =>
                              setAdditionalCoaPage(p => Math.max(0, p - 1))
                            }
                            disabled={page === 0}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border bg-background hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                          >
                            <ChevronLeft size={12} />
                            Previous
                          </button>
                          <span className="text-xs text-muted-foreground">
                            Page {page + 1} of {totalPages}
                            {' · '}
                            <span className="text-[11px]">
                              {pageStart + 1}–
                              {Math.min(
                                pageStart + PAGE_SIZE,
                                additionalCoas.length
                              )}{' '}
                              of {additionalCoas.length}
                            </span>
                          </span>
                          <button
                            onClick={() =>
                              setAdditionalCoaPage(p =>
                                Math.min(totalPages - 1, p + 1)
                              )
                            }
                            disabled={page >= totalPages - 1}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border bg-background hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                          >
                            Next
                            <ChevronRight size={12} />
                          </button>
                        </div>
                      )}
                    </SectionHeader>
                  </Card>
                )
              })()}

            <Card className="p-4">
              <SectionHeader icon={Layers} title="Analytes">
                {data.analytes.length > 0 ? (
                  <div className="space-y-3">
                    {data.analytes.map(analyte => {
                      const displayName =
                        analyteNameMap.get(analyte.slot_number) ??
                        analyte.raw_name
                      const slot = analyte.slot_number
                      const matchedPeptide = peptidesCatalog.find(
                        p => p.name === analyte.matched_peptide_name
                      )
                      const approvedAliases =
                        matchedPeptide?.display_aliases ?? []
                      const currentAlias = sampleAliases.get(slot) ?? ''
                      const handleAliasChange = async (next: string) => {
                        try {
                          if (!next) {
                            await clearSampleAnalyteAlias(data.sample_id, slot)
                            setSampleAliases(prev => {
                              const m = new Map(prev)
                              m.delete(slot)
                              return m
                            })
                          } else {
                            await setSampleAnalyteAlias(
                              data.sample_id,
                              slot,
                              next
                            )
                            setSampleAliases(prev =>
                              new Map(prev).set(slot, next)
                            )
                          }
                        } catch (e) {
                          toast.error('Failed to save alias', {
                            description:
                              e instanceof Error ? e.message : String(e),
                          })
                        }
                      }
                      return (
                        <div
                          key={slot}
                          className="p-2.5 rounded-lg bg-muted/50 border border-border/30 space-y-1"
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                A{slot}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                Analyte {slot}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                setReplaceSlot({
                                  slot,
                                  oldPeptideId:
                                    analyte.matched_peptide_id ?? null,
                                  oldPeptideName: displayName,
                                })
                              }
                              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                              title="Replace this analyte's peptide (wrong-variant correction)"
                            >
                              <RefreshCw size={11} aria-hidden="true" />
                              Replace
                            </button>
                          </div>
                          <div className="[&>div]:border-0 [&>div]:py-1">
                            <EditableDataRow
                              label="Peptide"
                              value={displayName}
                              senaiteField={`Analyte${slot}Peptide`}
                              sampleUid={data.sample_uid ?? ''}
                              onSaved={v =>
                                setData(prev => {
                                  if (!prev) return prev
                                  const updated = prev.analytes.map(a =>
                                    a.slot_number === slot
                                      ? {
                                          ...a,
                                          matched_peptide_name:
                                            (v as string) ??
                                            a.matched_peptide_name,
                                        }
                                      : a
                                  )
                                  return { ...prev, analytes: updated }
                                })
                              }
                            />
                            <EditableDataRow
                              label="Declared Qty"
                              value={analyte.declared_quantity}
                              senaiteField={`Analyte${slot}DeclaredQuantity`}
                              sampleUid={data.sample_uid ?? ''}
                              type="number"
                              mono
                              suffix="mg"
                              onSaved={v =>
                                setData(prev => {
                                  if (!prev) return prev
                                  const updated = prev.analytes.map(a =>
                                    a.slot_number === slot
                                      ? {
                                          ...a,
                                          declared_quantity:
                                            v != null ? Number(v) : null,
                                        }
                                      : a
                                  )
                                  return { ...prev, analytes: updated }
                                })
                              }
                            />
                            {approvedAliases.length > 0 && (
                              <div className="flex items-center justify-between py-1 text-xs">
                                <span className="text-muted-foreground">
                                  COA Alias
                                </span>
                                <select
                                  value={currentAlias}
                                  onChange={e =>
                                    handleAliasChange(e.target.value)
                                  }
                                  className="h-7 px-2 rounded-md border border-border bg-background text-xs max-w-[200px] cursor-pointer hover:bg-muted transition-colors"
                                  title="Name shown on the customer-facing COA. Conformance still matches the real peptide name."
                                >
                                  <option value="">
                                    — Use real name ({displayName}) —
                                  </option>
                                  {approvedAliases.map(alias => (
                                    <option key={alias} value={alias}>
                                      {alias}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No analytes defined
                  </p>
                )}
                {data.declared_weight_mg != null && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <DataRow
                      label="Total Declared Qty"
                      value={
                        <span className="font-mono text-amber-600 dark:text-amber-400 font-semibold">
                          {data.declared_weight_mg} mg
                        </span>
                      }
                      emphasis
                    />
                  </div>
                )}
              </SectionHeader>
            </Card>
          </div>
        </div>
      )}

      {/* Internal Remarks — full width (SENAITE-backed, lab-internal) */}
      <Card className="p-4 mb-6">
        <SectionHeader icon={MessageSquare} title="Internal Remarks">
          {data.remarks.length > 0 ? (
            <div className="space-y-2">
              {data.remarks.map((r, i) => (
                <InternalRemarkCard
                  key={`${r.user_id}-${r.created}-${i}`}
                  author={String(r.user_id ?? 'System')}
                  createdLabel={formatDate(r.created)}
                  content={r.content}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No remarks</p>
          )}
          {data.sample_uid && (
            <AddRemarkForm
              sampleUid={data.sample_uid}
              sampleId={data.sample_id}
              onAdded={() => fetchSample(data.sample_id)}
            />
          )}
        </SectionHeader>
      </Card>

      {/* Customer Remarks — delivered with the published COA (parents only) */}
      {isParent && (
        <Card className="p-4 mb-6">
          <SectionHeader icon={MessageSquare} title="Customer Remarks">
            <CustomerRemarksCard
              key={data.sample_id}
              sampleId={data.sample_id}
              initial={subData?.parent?.customer_remarks ?? ''}
              initialInclude={subData?.parent?.customer_remarks_include ?? true}
              deliveredAt={
                subData?.parent?.customer_remarks_delivered_at ?? null
              }
              onSaved={() => refetchSubs()}
            />
          </SectionHeader>
        </Card>
      )}

      {/* Attachments */}
      <Card className="p-4 mb-6">
        <SectionHeader
          icon={Paperclip}
          title={`Attachments (${
            (data.attachments?.length ?? 0) +
            // Vial pages also count the Mk1-side items rendered below: the
            // check-in photo (if any) + extra images + prep chromatograms.
            (parentSampleId !== null
              ? (vialPhotoUrl ? 1 : 0) +
                vialAttachments.length +
                vialChromatograms.length
              : 0)
          })`}
        >
          <div className="space-y-4">
            {/* Vial pages: Mk1-stored check-in photo + extra sample images.
                  Legacy SENAITE attachments (if any) still render below. */}
            {parentSampleId !== null && data.sample_id && (
              <VialAttachmentsBlock
                sampleId={data.sample_id}
                photoUrl={vialPhotoUrl}
                photoIsMk1={
                  !!parentSummary?.sub_samples
                    .find(s => s.sample_id === sampleId)
                    ?.photo_external_uid?.startsWith('mk1://')
                }
                attachments={vialAttachments}
                chromatograms={vialChromatograms}
                onPhotoChanged={refreshVialPhoto}
                onAttachmentsChanged={refreshVialAttachments}
              />
            )}
            {/* Packaging photos (Mk1) — read-only; parent id is `parentSampleId`
                on vial pages, else this page's own `data.sample_id`. Renders
                nothing when the parent has no packaging photos. */}
            {data.sample_id && (
              <PackagingAttachmentsGroup
                parentSampleId={parentSampleId ?? data.sample_id}
              />
            )}
            {/* Renderable attachments — newest image + newest HPLC graph side by side */}
            {(() => {
              const allImages = (data.attachments ?? []).filter(a =>
                a.content_type?.startsWith('image/')
              )
              const allHplc = (data.attachments ?? []).filter(isHplcGraph)
              const newestImage = allImages[allImages.length - 1]
              const newestHplc = allHplc[allHplc.length - 1]
              const olderImages = allImages.slice(0, -1)
              const olderHplc = allHplc.slice(0, -1)
              if (!newestImage && !newestHplc) return null

              const renderItem = (attachment: SenaiteAttachment) => (
                <div key={attachment.uid} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    {attachment.content_type?.startsWith('image/') ? (
                      <ImageIcon
                        size={13}
                        className="text-muted-foreground shrink-0"
                      />
                    ) : (
                      <Paperclip
                        size={13}
                        className="text-muted-foreground shrink-0"
                      />
                    )}
                    <span className="text-xs font-medium text-foreground truncate">
                      {attachment.filename}
                    </span>
                    {attachment.attachment_type && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] shrink-0"
                      >
                        {attachment.attachment_type}
                      </Badge>
                    )}
                  </div>
                  {attachment.content_type?.startsWith('image/') ? (
                    <AttachmentImage attachment={attachment} />
                  ) : (
                    (() => {
                      const activeGen = coaGenerations.find(
                        g =>
                          g.parent_generation_id == null &&
                          g.status !== 'superseded'
                      )
                      return (
                        <TabbedChromatogramChart
                          attachment={attachment}
                          verificationCode={
                            activeGen?.verification_code ?? null
                          }
                          has5k={!!activeGen?.chromatogram_5k_url}
                          has10k={!!activeGen?.chromatogram_10k_url}
                        />
                      )
                    })()
                  )}
                </div>
              )

              return (
                <div className="space-y-3">
                  {/* Newest of each type side by side */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {newestImage && renderItem(newestImage)}
                    {newestHplc && renderItem(newestHplc)}
                  </div>
                  {/* Older images */}
                  {olderImages.length > 0 && (
                    <div>
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation()
                          setShowOlderImages(v => !v)
                        }}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                      >
                        {showOlderImages ? (
                          <ChevronDown size={11} />
                        ) : (
                          <ChevronRight size={11} />
                        )}
                        {olderImages.length} older image
                        {olderImages.length !== 1 ? 's' : ''}
                      </button>
                      {showOlderImages && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                          {olderImages.map(renderItem)}
                        </div>
                      )}
                    </div>
                  )}
                  {/* Older HPLC graphs */}
                  {olderHplc.length > 0 && (
                    <div>
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation()
                          setShowOlderHplc(v => !v)
                        }}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                      >
                        {showOlderHplc ? (
                          <ChevronDown size={11} />
                        ) : (
                          <ChevronRight size={11} />
                        )}
                        {olderHplc.length} older HPLC graph
                        {olderHplc.length !== 1 ? 's' : ''}
                      </button>
                      {showOlderHplc && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                          {olderHplc.map(renderItem)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })()}
            {/* Other file attachments (non-image, non-HPLC) */}
            {data.attachments
              ?.filter(a => !isRenderable(a))
              .map(attachment => (
                <div
                  key={attachment.uid}
                  className="flex items-center gap-2 p-2 rounded-lg bg-muted/40 border border-border/30"
                >
                  <Paperclip
                    size={14}
                    className="text-muted-foreground shrink-0"
                  />
                  <span className="text-sm text-foreground truncate">
                    {attachment.filename}
                  </span>
                  {attachment.attachment_type && (
                    <Badge variant="secondary" className="text-[10px] shrink-0">
                      {attachment.attachment_type}
                    </Badge>
                  )}
                </div>
              ))}
            {/* SENAITE upload form — not for Mk1-native vials, whose
                  "sample_uid" is an mk1:// provenance marker, not a SENAITE
                  UID (the upload would 502). They use AddVialImageForm above. */}
            {data.sample_uid && !data.sample_uid.startsWith('mk1://') && (
              <AddAttachmentForm
                sampleUid={data.sample_uid}
                onUploaded={() => fetchSample(data.sample_id)}
              />
            )}
            {/* Parent pages: attach a vial's primary photo to this sample.
                  Only offered when at least one vial has an Mk1-stored
                  primary (legacy vial photos already live on this AR). */}
            {parentSampleId === null &&
              data.sample_uid &&
              ((subData?.sub_samples.some(v =>
                v.photo_external_uid?.startsWith('mk1://')
              ) ??
                false) ||
                vialChromatograms.length > 0) && (
                <div
                  className="pt-3 border-t border-border/40 flex items-center gap-2 flex-wrap"
                  onClick={e => e.stopPropagation()}
                >
                  {(subData?.sub_samples.some(v =>
                    v.photo_external_uid?.startsWith('mk1://')
                  ) ??
                    false) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs"
                      onClick={() => setSelectVialImageOpen(true)}
                    >
                      <ImageIcon size={13} />
                      Select Vial Image
                    </Button>
                  )}
                  {vialChromatograms.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs"
                      onClick={() => setSelectVialChromOpen(true)}
                    >
                      <Activity size={13} />
                      Select Vial Chromatogram
                    </Button>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    Attach a vial&apos;s photo or chromatogram to this sample
                  </span>
                </div>
              )}
          </div>
        </SectionHeader>
      </Card>

      {/* Manage Analyses + Vials Quick Look */}
      {data.review_state && (
        <div className="mb-2 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={openManageAnalyses}
          >
            <Plus size={13} />
            Manage Analyses
          </Button>
          {parentSampleId === null && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              disabled={subSamples.length === 0}
              title={subSamples.length === 0 ? 'No vials yet' : undefined}
              onClick={() => setVialsQuickLookOpen(true)}
            >
              <Eye size={13} />
              Vials Quick Look
            </Button>
          )}
        </div>
      )}

      {/* Manage Analyses Panel */}
      {manageAnalysesOpen && (
        <Card className="mb-3 border-dashed">
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium">Manage Analyses</h3>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={() => setManageAnalysesOpen(false)}
              >
                <X size={14} />
              </Button>
            </div>

            {/* Cascade help — parent pages with vials only: changes made
                  here flow down to the sub-sample vials */}
            {parentSampleId === null && subSamples.length > 0 && (
              <div className="mb-4 flex gap-2 rounded-md border border-border bg-muted/40 p-2.5">
                <Info
                  size={14}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                />
                <div className="text-xs text-muted-foreground space-y-1">
                  <p className="font-medium text-foreground">
                    Changes here also update this sample's vials
                  </p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    <li>
                      <span className="text-foreground">Adding</span> a service
                      puts it on every assigned vial right away. Vials only
                      receive tests that fit their role — micro tests won't be
                      added to HPLC vials.
                    </li>
                    <li>
                      <span className="text-foreground">Removing</span> a
                      service only clears it from vials that haven't touched the
                      test — no value entered and not on a worksheet yet.
                    </li>
                    <li>
                      <span className="text-foreground">Rejecting</span> a
                      service (in the analyses table) also clears tests already
                      sitting on a worksheet, as long as no value was entered —
                      and it keeps a record. Adding the service back later
                      restores it on the vials.
                    </li>
                    <li>
                      <span className="text-foreground">
                        Entered results are never deleted from here.
                      </span>{' '}
                      If a vial already has a value for the test, that work
                      stays — clear it on the vial itself if it really needs to
                      go.
                    </li>
                  </ul>
                </div>
              </div>
            )}

            {/* Hide the HPLC analyte family (identity/purity/quantity) — these
                  are managed via Replace on the Analytes card; adding/removing
                  them here leaves the slot + vials out of sync. */}
            <label className="mb-3 flex items-center gap-2 cursor-pointer select-none text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={hideHplcServices}
                onChange={e => setHideHplcServices(e.target.checked)}
                className="size-3.5 rounded border-border accent-primary cursor-pointer"
              />
              Hide HPLC identity / purity / quantity
              <span className="text-muted-foreground/60">
                — managed via Replace on the Analytes card
              </span>
            </label>

            {/* Parent pages only: result entry on the parent is hidden by
                  default to steer work onto the vials. Opt-in here when the lab
                  really needs to enter a value at the parent tier. */}
            {parentSampleId === null && (
              <label className="mb-3 flex items-center gap-2 cursor-pointer select-none text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={showParentResultEditing}
                  onChange={e => setShowParentResultEditing(e.target.checked)}
                  className="size-3.5 rounded border-border accent-primary cursor-pointer"
                />
                Allow result entry on this parent
                <span className="text-muted-foreground/60">
                  — results normally belong on the vials
                </span>
              </label>
            )}

            {/* Current analyses with remove buttons */}
            <div className="mb-4">
              <p className="text-xs text-muted-foreground mb-2">
                Current analyses
              </p>
              <div className="space-y-1">
                {analyses
                  .filter(
                    a =>
                      a.review_state &&
                      !['retracted', 'cancelled'].includes(a.review_state)
                  )
                  .filter(
                    a => !hideHplcServices || !isHplcAnalyteService(a.keyword)
                  )
                  .map(a => (
                    <div
                      key={a.keyword ?? a.uid}
                      className="flex items-center justify-between py-1 px-2 rounded bg-muted/40"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-mono text-muted-foreground shrink-0">
                          {a.keyword}
                        </span>
                        {/* Show the resolved analyte name (e.g. "TB500 (Purity)")
                              for generic ANALYTE-N services, matching the renamed
                              titles in the AnalysisTable below. */}
                        <span className="text-xs truncate">
                          {formatAnalysisTitle(a.title, analyteNameMap).display}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                        disabled={removingKeyword === a.keyword}
                        onClick={() =>
                          handleRemoveAnalysis(a.keyword ?? '', a.title)
                        }
                      >
                        {removingKeyword === a.keyword ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Trash2 size={12} />
                        )}
                      </Button>
                    </div>
                  ))}
              </div>
            </div>

            {/* Add new analysis */}
            <div>
              <p className="text-xs text-muted-foreground mb-2">Add analysis</p>
              <div className="relative mb-2">
                <Search
                  size={12}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="text"
                  placeholder="Search services..."
                  value={serviceSearch}
                  onChange={e => setServiceSearch(e.target.value)}
                  className="w-full pl-7 pr-3 py-1.5 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              {servicesLoading ? (
                <div className="flex justify-center py-4">
                  <Loader2
                    size={16}
                    className="animate-spin text-muted-foreground"
                  />
                </div>
              ) : (
                <div className="max-h-48 overflow-y-auto space-y-0.5">
                  {availableServices
                    .filter(
                      s => !hideHplcServices || !isHplcAnalyteService(s.keyword)
                    )
                    .filter(s => {
                      const q = serviceSearch.toLowerCase()
                      return (
                        !q ||
                        s.title.toLowerCase().includes(q) ||
                        s.keyword.toLowerCase().includes(q)
                      )
                    })
                    .filter(
                      s =>
                        !analyses.some(
                          a =>
                            a.keyword === s.keyword &&
                            a.review_state !== 'retracted'
                        )
                    )
                    .map(s => (
                      <div
                        key={s.uid}
                        className="flex items-center justify-between py-1 px-2 rounded hover:bg-muted/60"
                      >
                        <div className="min-w-0">
                          <span className="text-xs truncate block">
                            {s.title}
                          </span>
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {s.keyword}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 shrink-0"
                          disabled={addingService === s.uid}
                          onClick={() => handleAddAnalysis(s)}
                        >
                          {addingService === s.uid ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Plus size={12} />
                          )}
                        </Button>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Retract-confirm modal for removing a service with worked vial results */}
      <RemovalConfirmModal
        open={removalModal !== null}
        serviceTitle={
          removalModal
            ? formatAnalysisTitle(removalModal.title, analyteNameMap).display
            : ''
        }
        impact={removalModal?.impact ?? null}
        pending={
          removingKeyword !== null && removingKeyword === removalModal?.keyword
        }
        onConfirm={() => {
          if (removalModal)
            performRemoveAnalysis(
              removalModal.keyword,
              removalModal.title,
              true
            )
        }}
        onCancel={() => setRemovalModal(null)}
      />

      {/* Replace-analyte dialog (wrong-variant correction) */}
      {replaceSlot && data && (
        <ReplaceAnalyteDialog
          open
          sampleId={data.sample_id}
          senaiteUid={data.sample_uid ?? ''}
          slot={replaceSlot.slot}
          oldPeptideId={replaceSlot.oldPeptideId}
          oldPeptideName={replaceSlot.oldPeptideName}
          onClose={() => setReplaceSlot(null)}
          onReplaced={() => refreshSample(data.sample_id)}
        />
      )}

      {/* Analyses Table */}
      <AnalysisTable
        analyses={analyses}
        analyteNameMap={analyteNameMap}
        primaryAnalysisUids={primaryAnalysisUids}
        primaryRole={currentAssignment}
        promotionsByKeyword={
          parentSampleId === null ? promotionsByKeyword : undefined
        }
        vialAssignmentByKeyword={
          parentSampleId === null ? vialAssignmentByKeyword : undefined
        }
        onVialMethodInstrumentSaved={() => {
          queryClient.invalidateQueries({ queryKey: [VIAL_OVERLAY_QUERY_KEY] })
        }}
        parentLineStates={
          parentSampleId !== null ? parentLineStates : undefined
        }
        resultsReadOnly={parentSampleId === null && !showParentResultEditing}
        onResultSaved={(uid, newResult, newReviewState) => {
          setData(prev => {
            if (!prev) return prev
            return {
              ...prev,
              analyses: prev.analyses.map(a =>
                a.uid === uid
                  ? {
                      ...a,
                      result: newResult,
                      review_state: newReviewState ?? a.review_state,
                    }
                  : a
              ),
            }
          })
        }}
        onMethodInstrumentSaved={(uid, field, newUid, newTitle) => {
          setData(prev => {
            if (!prev) return prev
            return {
              ...prev,
              analyses: prev.analyses.map(a =>
                a.uid === uid
                  ? field === 'method'
                    ? { ...a, method: newTitle, method_uid: newUid }
                    : { ...a, instrument: newTitle, instrument_uid: newUid }
                  : a
              ),
            }
          })
        }}
        onTransitionComplete={() => refreshSample(data.sample_id)}
        analysisSlaMap={analysisSla.byKeyword}
        isAnalysisSlaLoading={analysisSla.isLoading}
        isAnalysisSlaError={analysisSla.isError}
        isAnalysisSlaPublished={analysisSla.isPublished}
        analysisSlaPriority={analysisSla.priority}
        vialKind={currentVialKind}
      />

      {parentSampleId === null && data.sample_id && (
        <VialsQuickLookDialog
          open={vialsQuickLookOpen}
          onOpenChange={setVialsQuickLookOpen}
          parentSampleId={data.sample_id}
          analyteNameMap={analyteNameMap}
          onParentDataStale={() => refreshSample(data.sample_id)}
        />
      )}

      {parentSampleId === null && data.sample_id && data.sample_uid && (
        <SelectVialImageDialog
          open={selectVialImageOpen}
          onOpenChange={setSelectVialImageOpen}
          parentSampleId={data.sample_id}
          parentSampleUid={data.sample_uid}
          vials={subData?.sub_samples ?? []}
          containerMode={subData?.parent.container_mode ?? false}
          onAttached={() => {
            // Header thumb: remount → picks up the freshly seeded cache
            // entry immediately (no SENAITE read-after-write race).
            setVialPhotoVersion(v => v + 1)
            // Attachments list: re-pull the lookup. SENAITE's attachment
            // listing can lag a beat; the next refresh catches up if so.
            refreshSample(data.sample_id)
          }}
        />
      )}

      {parentSampleId === null && data.sample_id && data.sample_uid && (
        <SelectVialChromatogramDialog
          open={selectVialChromOpen}
          onOpenChange={setSelectVialChromOpen}
          parentSampleId={data.sample_id}
          parentSampleUid={data.sample_uid}
          chromatograms={vialChromatograms}
          containerMode={subData?.parent.container_mode ?? false}
          onAttached={() => refreshSample(data.sample_id)}
        />
      )}

      {/* Sub-Samples + Sub-Sample Analyses sections moved into the wizard's
            "Sub Sample Details" tab (open via "Manage Sub-Samples" button).
            Entry from the sample-details page defaults to that tab so techs
            land on the table they came in for, not the new-vial form. Hosted
            unconditionally so the button also works on sub-sample pages —
            openSubSampleWizard resolves the parent UID for that case. */}
      {wizardParent && (
        <Dialog
          open={Boolean(wizardParent)}
          onOpenChange={open => {
            if (!open) {
              setWizardParent(null)
              void refetchSubs()
            }
          }}
        >
          <DialogContent className="max-w-[95vw] w-[95vw] sm:max-w-[95vw] h-[92vh] p-0 gap-0 grid-rows-[auto_1fr] overflow-hidden">
            <DialogHeader className="px-6 pt-4 pb-2 border-b">
              <DialogTitle>Receive {wizardParent.sample_id}</DialogTitle>
            </DialogHeader>
            <div className="min-h-0 overflow-hidden">
              <ReceiveWizard
                parent={wizardParent}
                initialPhase="details"
                boxing={wizardBoxing}
                onClose={() => {
                  setWizardParent(null)
                  void refetchSubs()
                }}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Woo Order flyout */}
      {wooOrderOpen && (
        <WooOrderFlyout
          order={wooOrderData}
          loading={wooOrderLoading}
          onClose={() => {
            setWooOrderOpen(false)
            setWooOrderData(null)
          }}
        />
      )}

      {/* HPLC Results flyout */}
      {hplcFlyoutPrep && hplcFlyoutMatch && (
        <SamplePrepHplcFlyout
          open={true}
          onClose={() => {
            setHplcFlyoutPrep(null)
            setHplcFlyoutMatch(null)
          }}
          prep={hplcFlyoutPrep}
          match={hplcFlyoutMatch}
          readOnly
        />
      )}

      {/* Activity log flyout */}
      <SampleActivityLog
        open={activityLogOpen}
        onClose={() => setActivityLogOpen(false)}
        sampleId={sampleId || ''}
      />

      {/* Registry debug panel (admin-only) */}
      <SampleRegistryDebug
        open={registryDebugOpen}
        onClose={() => setRegistryDebugOpen(false)}
        sampleId={sampleId ?? ''}
      />

      {/* Single-label print portal — off-screen DOM the print CSS reveals */}
      <PrintLabelPortal target={printTarget} />

      {/* Variance summary dialog */}
      {isParent && sampleId && (
        <VarianceSummary
          parentSampleId={sampleId}
          open={varianceSummaryOpen}
          onOpenChange={setVarianceSummaryOpen}
        />
      )}
    </div>
  )
}
