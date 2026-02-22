import { useState, useEffect, useCallback } from 'react'
import {
  Check,
  Loader2,
  ClipboardCheck,
  RefreshCw,
  XCircle,
  FlaskConical,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  FileText,
  Image,
  RotateCcw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { PhotoCapture } from '@/components/intake/PhotoCapture'
import {
  lookupSenaiteSample,
  getSenaiteSamples,
  getSenaiteStatus,
  receiveSenaiteSample,
  type SenaiteLookupResult,
  type SenaiteSample,
  type SenaiteReceiveSampleResponse,
} from '@/lib/api'

type IntakeStep = 1 | 2

const INTAKE_STEPS: { id: IntakeStep; label: string }[] = [
  { id: 1, label: 'Samples' },
  { id: 2, label: 'Sample Details' },
]

type SortColumn =
  | 'id'
  | 'client_order_number'
  | 'client_id'
  | 'sample_type'
  | 'date_sampled'
  | 'review_state'
type SortDir = 'asc' | 'desc'

function SortableHead({
  column,
  label,
  activeColumn,
  direction,
  onSort,
  className,
}: {
  column: SortColumn
  label: string
  activeColumn: SortColumn | null
  direction: SortDir
  onSort: (col: SortColumn) => void
  className?: string
}) {
  const isActive = activeColumn === column
  return (
    <TableHead
      className={cn('cursor-pointer select-none', className)}
      onClick={() => onSort(column)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          direction === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </span>
    </TableHead>
  )
}

const STATE_LABELS: Record<string, { label: string; className: string }> = {
  sample_registered: {
    label: 'Registered',
    className: 'bg-zinc-700 text-zinc-200',
  },
  sample_due: { label: 'Due', className: 'bg-yellow-900 text-yellow-300' },
  sample_received: {
    label: 'Received',
    className: 'bg-blue-900 text-blue-300',
  },
  waiting_for_addon_results: {
    label: 'Waiting Addon',
    className: 'bg-indigo-900 text-indigo-300',
  },
  ready_for_review: {
    label: 'Ready for Review',
    className: 'bg-cyan-900 text-cyan-300',
  },
  to_be_verified: {
    label: 'To Verify',
    className: 'bg-orange-900 text-orange-300',
  },
  verified: { label: 'Verified', className: 'bg-green-900 text-green-300' },
  published: { label: 'Published', className: 'bg-purple-900 text-purple-300' },
  cancelled: { label: 'Cancelled', className: 'bg-red-900 text-red-300' },
  invalid: { label: 'Invalid', className: 'bg-red-900 text-red-300' },
}

function StateBadge({ state }: { state: string }) {
  const config = STATE_LABELS[state] ?? {
    label: state,
    className: 'bg-zinc-700 text-zinc-200',
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  )
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatRelativeDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return '—'
  const diff = Date.now() - date.getTime()
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (mins > 0) return `${mins}m ago`
  return 'just now'
}

function InlineField({
  label,
  value,
}: {
  label: string
  value: string | null | undefined
}) {
  return (
    <div className="flex items-baseline gap-1.5 min-w-0 text-sm">
      <span className="text-muted-foreground text-xs uppercase tracking-wider shrink-0">
        {label}
      </span>
      <span className="font-medium truncate">{value || '—'}</span>
    </div>
  )
}

export function ReceiveSample() {
  const [currentStep, setCurrentStep] = useState<IntakeStep>(1)
  const [completedSteps, setCompletedSteps] = useState<Set<IntakeStep>>(
    new Set()
  )

  // Step 1: Due samples list
  const [dueSamples, setDueSamples] = useState<SenaiteSample[]>([])
  const [dueSamplesTotal, setDueSamplesTotal] = useState(0)
  const [dueSamplesLoading, setDueSamplesLoading] = useState(true)
  const [dueSamplesConnected, setDueSamplesConnected] = useState(false)
  const [dueSamplesError, setDueSamplesError] = useState<string | null>(null)
  const [selectedSample, setSelectedSample] = useState<SenaiteSample | null>(
    null
  )
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  function handleSort(col: SortColumn) {
    if (sortColumn === col) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortColumn(col)
      setSortDir('asc')
    }
  }

  const sortedSamples = sortColumn
    ? [...dueSamples].sort((a, b) => {
        const valA = a[sortColumn] ?? ''
        const valB = b[sortColumn] ?? ''
        const cmp = String(valA).localeCompare(String(valB), undefined, {
          numeric: true,
        })
        return sortDir === 'asc' ? cmp : -cmp
      })
    : dueSamples

  const loadDueSamples = useCallback(async () => {
    setDueSamplesLoading(true)
    setDueSamplesError(null)
    try {
      const status = await getSenaiteStatus()
      setDueSamplesConnected(status.enabled)
      if (status.enabled) {
        const result = await getSenaiteSamples('sample_due', 50, 0)
        setDueSamples(result.items)
        setDueSamplesTotal(result.total)
      }
    } catch (e) {
      setDueSamplesConnected(false)
      setDueSamplesError(
        e instanceof Error ? e.message : 'Failed to load samples'
      )
    } finally {
      setDueSamplesLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDueSamples()
  }, [loadDueSamples])

  // Captured photo
  const [capturedPhotoUrl, setCapturedPhotoUrl] = useState<string | null>(null)

  // Check-in to SENAITE
  const [receiveLoading, setReceiveLoading] = useState(false)
  const [receiveResult, setReceiveResult] =
    useState<SenaiteReceiveSampleResponse | null>(null)
  const [receiveError, setReceiveError] = useState<string | null>(null)
  const [remarks, setRemarks] = useState('')

  async function handleReceiveSample() {
    if (!selectedSample) return
    setReceiveLoading(true)
    setReceiveError(null)
    setReceiveResult(null)
    try {
      const result = await receiveSenaiteSample(
        selectedSample.uid,
        selectedSample.id,
        capturedPhotoUrl,
        remarks || null
      )
      setReceiveResult(result)
    } catch (err) {
      setReceiveError(err instanceof Error ? err.message : 'Receive failed')
    } finally {
      setReceiveLoading(false)
    }
  }

  // Step 2: SENAITE detailed lookup
  const [lookupLoading, setLookupLoading] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lookupResult, setLookupResult] = useState<SenaiteLookupResult | null>(
    null
  )
  const [pendingLookupId, setPendingLookupId] = useState<string | null>(null)

  async function handleLookup(sampleId: string) {
    if (!sampleId) return
    setLookupLoading(true)
    setLookupError(null)
    setLookupResult(null)
    try {
      const result = await lookupSenaiteSample(sampleId)
      setLookupResult(result)
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Lookup failed')
    } finally {
      setLookupLoading(false)
    }
  }

  // Auto-lookup when arriving at step 2 with a pending sample from step 1
  useEffect(() => {
    if (currentStep === 2 && pendingLookupId) {
      setPendingLookupId(null)
      void handleLookup(pendingLookupId)
    }
  }, [currentStep, pendingLookupId])

  function handleCheckInAnother() {
    setCurrentStep(1)
    setCompletedSteps(new Set())
    setSelectedSample(null)
    setLookupResult(null)
    setLookupError(null)
    setPendingLookupId(null)
    setCapturedPhotoUrl(null)
    setReceiveLoading(false)
    setReceiveResult(null)
    setReceiveError(null)
    setRemarks('')
    void loadDueSamples()
  }

  function handleNext() {
    // When advancing from Samples → Sample Details, auto-lookup the selected sample
    if (currentStep === 1 && selectedSample) {
      setLookupError(null)
      setLookupResult(null)
      setPendingLookupId(selectedSample.id)
    }
    setCompletedSteps(prev => new Set([...prev, currentStep]))
    if (currentStep < 2) setCurrentStep((currentStep + 1) as IntakeStep)
  }

  function handleBack() {
    if (currentStep > 1) setCurrentStep((currentStep - 1) as IntakeStep)
  }

  const canGoNext =
    currentStep === 1 ? selectedSample !== null : false

  return (
    <div className="flex h-full flex-col sm:flex-row">
      {/* Left step sidebar — horizontal on mobile, vertical on desktop */}
      <div className="shrink-0 border-b sm:border-b-0 sm:border-r sm:w-56 p-3 sm:p-4">
        <h2 className="mb-3 sm:mb-4 text-sm font-semibold text-muted-foreground uppercase tracking-wider hidden sm:block">
          Receive Sample
        </h2>
        <nav className="flex flex-row sm:flex-col gap-1 overflow-x-auto">
          {INTAKE_STEPS.map(step => {
            const isCompleted = completedSteps.has(step.id)
            const isActive = step.id === currentStep
            const isAccessible = isCompleted || step.id === currentStep

            return (
              <button
                key={step.id}
                type="button"
                onClick={() => isAccessible && setCurrentStep(step.id)}
                disabled={!isAccessible}
                className={cn(
                  'flex items-center gap-2 sm:gap-3 rounded-md px-2 py-1.5 sm:px-3 sm:py-2 text-start text-sm transition-colors shrink-0 sm:w-full',
                  isActive &&
                    'bg-accent sm:border-l-2 sm:border-primary sm:pl-2.5',
                  isAccessible &&
                    !isActive &&
                    'cursor-pointer hover:bg-accent/60',
                  !isAccessible && 'cursor-not-allowed opacity-50'
                )}
              >
                <span
                  className={cn(
                    'flex h-7 w-7 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-full text-xs sm:text-sm font-medium transition-colors',
                    isCompleted && 'bg-green-500 text-white',
                    isActive &&
                      !isCompleted &&
                      'bg-primary text-primary-foreground',
                    !isActive &&
                      !isCompleted &&
                      'bg-muted text-muted-foreground'
                  )}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : step.id}
                </span>
                <span
                  className={cn(
                    'truncate hidden sm:inline',
                    isActive && 'font-semibold',
                    !isActive && !isCompleted && 'text-muted-foreground'
                  )}
                >
                  {step.label}
                </span>
              </button>
            )
          })}
        </nav>
      </div>

      {/* Right content */}
      <div className="flex flex-1 flex-col min-h-0">
        <ScrollArea className="flex-1">
          <div className="p-4 sm:p-6">
            {/* Step 1: Samples */}
            {currentStep === 1 && (
              <div className="flex flex-col gap-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-2xl font-bold tracking-tight">
                      Samples
                    </h1>
                    <p className="text-muted-foreground">
                      {dueSamplesConnected &&
                      !dueSamplesLoading &&
                      dueSamplesTotal > 0
                        ? `${dueSamplesTotal} due sample${dueSamplesTotal !== 1 ? 's' : ''} — select one to receive`
                        : 'Select a due sample from SENAITE to receive'}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void loadDueSamples()}
                    className="h-8 w-8"
                    title="Refresh"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${dueSamplesLoading ? 'animate-spin' : ''}`}
                    />
                  </Button>
                </div>

                {dueSamplesLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : !dueSamplesConnected ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
                    <XCircle className="h-6 w-6" />
                    <p className="text-sm">
                      {dueSamplesError ?? 'SENAITE not connected'}
                    </p>
                  </div>
                ) : dueSamplesError ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
                    <XCircle className="h-6 w-6" />
                    <p className="text-sm">{dueSamplesError}</p>
                  </div>
                ) : dueSamples.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
                    <FlaskConical className="h-6 w-6" />
                    <p className="text-sm">No due samples found</p>
                  </div>
                ) : (
                  <div className="overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <SortableHead
                            column="id"
                            label="Sample ID"
                            activeColumn={sortColumn}
                            direction={sortDir}
                            onSort={handleSort}
                            className="w-32"
                          />
                          <SortableHead
                            column="client_order_number"
                            label="Order #"
                            activeColumn={sortColumn}
                            direction={sortDir}
                            onSort={handleSort}
                            className="w-36"
                          />
                          <SortableHead
                            column="client_id"
                            label="Client"
                            activeColumn={sortColumn}
                            direction={sortDir}
                            onSort={handleSort}
                          />
                          <SortableHead
                            column="sample_type"
                            label="Sample Type"
                            activeColumn={sortColumn}
                            direction={sortDir}
                            onSort={handleSort}
                          />
                          <SortableHead
                            column="date_sampled"
                            label="Date Sampled"
                            activeColumn={sortColumn}
                            direction={sortDir}
                            onSort={handleSort}
                            className="w-36"
                          />
                          <SortableHead
                            column="review_state"
                            label="State"
                            activeColumn={sortColumn}
                            direction={sortDir}
                            onSort={handleSort}
                            className="w-28 text-center"
                          />
                          <SortableHead
                            column="date_sampled"
                            label="Age"
                            activeColumn={sortColumn}
                            direction={sortDir}
                            onSort={handleSort}
                            className="w-20 text-right"
                          />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortedSamples.map(s => (
                          <TableRow
                            key={s.uid}
                            className={cn(
                              'cursor-pointer',
                              selectedSample?.uid === s.uid
                                ? 'bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-950/40'
                                : 'hover:bg-muted/30'
                            )}
                            onClick={() => {
                              setSelectedSample(s)
                              setLookupError(null)
                              setLookupResult(null)
                              setPendingLookupId(s.id)
                              setCompletedSteps(
                                prev => new Set([...prev, 1 as IntakeStep])
                              )
                              setCurrentStep(2)
                            }}
                          >
                            <TableCell className="font-mono text-sm">
                              {s.id}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {s.client_order_number ?? '—'}
                            </TableCell>
                            <TableCell className="text-sm">
                              {s.client_id ?? '—'}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {s.sample_type ?? '—'}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {formatDate(s.date_sampled)}
                            </TableCell>
                            <TableCell className="text-center">
                              <StateBadge state={s.review_state} />
                            </TableCell>
                            <TableCell className="text-right text-xs font-mono text-orange-400">
                              {formatRelativeDate(s.date_sampled)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}

            {/* Step 2: Sample Details */}
            {currentStep === 2 && (
              <div className="flex flex-col gap-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-2xl font-bold tracking-tight">
                      Sample Details
                      {lookupResult && (
                        <span className="ml-2 text-base font-mono text-muted-foreground">
                          {lookupResult.sample_id}
                        </span>
                      )}
                    </h1>
                  </div>
                  {lookupResult?.review_state && (
                    <StateBadge state={lookupResult.review_state} />
                  )}
                </div>

                {lookupLoading && (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                )}

                {lookupError && (
                  <Alert variant="destructive">
                    <AlertDescription>{lookupError}</AlertDescription>
                  </Alert>
                )}

                {lookupResult && !lookupLoading && (
                  <Card className="border-blue-200 bg-blue-50/60 dark:border-slate-600/40 dark:bg-slate-900/30">
                    <CardContent className="pt-5 space-y-4">
                      {/* Sample fields */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
                        <InlineField
                          label="Client"
                          value={lookupResult.client}
                        />
                        <InlineField
                          label="Sample Type"
                          value={lookupResult.sample_type}
                        />
                        <InlineField
                          label="Contact"
                          value={lookupResult.contact}
                        />
                        <InlineField
                          label="Order #"
                          value={lookupResult.client_order_number}
                        />
                        <InlineField
                          label="Date Received"
                          value={
                            lookupResult.date_received
                              ? formatDate(lookupResult.date_received)
                              : null
                          }
                        />
                        <InlineField
                          label="Client Sample ID"
                          value={lookupResult.client_sample_id}
                        />
                        <InlineField
                          label="Date Sampled"
                          value={
                            lookupResult.date_sampled
                              ? formatDate(lookupResult.date_sampled)
                              : null
                          }
                        />
                        <InlineField
                          label="Client Lot"
                          value={lookupResult.client_lot}
                        />
                        <InlineField
                          label="Profiles"
                          value={
                            lookupResult.profiles.length > 0
                              ? lookupResult.profiles.join(', ')
                              : null
                          }
                        />
                      </div>

                      {/* Analytes */}
                      <div className="border-t border-border/50 pt-3 space-y-2">
                        <InlineField
                          label="Declared Qty"
                          value={
                            lookupResult.declared_weight_mg != null
                              ? `${lookupResult.declared_weight_mg} mg`
                              : null
                          }
                        />
                        {lookupResult.analytes.length > 0 ? (
                          <div className="flex flex-wrap gap-x-4 gap-y-1">
                            {lookupResult.analytes.map((a, i) => (
                              <span key={i} className="text-sm font-medium">
                                {a.raw_name}
                                {a.matched_peptide_name && (
                                  <span className="text-muted-foreground text-xs ml-1">
                                    → {a.matched_peptide_name}
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            No analytes specified
                          </p>
                        )}
                      </div>

                      {/* COA — collapsible */}
                      <details className="border-t border-border/50 pt-3 group">
                        <summary className="flex items-center gap-2 cursor-pointer text-sm font-medium select-none">
                          <FileText className="h-4 w-4 text-blue-500 dark:text-slate-400" />
                          COA Information
                        </summary>
                        <div className="mt-3 space-y-3">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
                            <InlineField
                              label="Company"
                              value={lookupResult.coa.company_name}
                            />
                            <InlineField
                              label="Email"
                              value={lookupResult.coa.email}
                            />
                            <InlineField
                              label="Website"
                              value={lookupResult.coa.website}
                            />
                            <InlineField
                              label="Address"
                              value={lookupResult.coa.address}
                            />
                            <InlineField
                              label="Verification"
                              value={lookupResult.coa.verification_code}
                            />
                          </div>
                          <div className="flex flex-wrap gap-4">
                            <div className="flex flex-col gap-1">
                              <span className="text-xs text-muted-foreground uppercase tracking-wider">
                                Logo
                              </span>
                              {lookupResult.coa.company_logo_url ? (
                                <div className="h-12 w-20 rounded border bg-white flex items-center justify-center overflow-hidden">
                                  <img
                                    src={lookupResult.coa.company_logo_url}
                                    alt="Company logo"
                                    className="max-h-full max-w-full object-contain"
                                  />
                                </div>
                              ) : (
                                <div className="h-12 w-20 rounded border bg-muted flex items-center justify-center">
                                  <Image className="h-4 w-4 text-muted-foreground opacity-40" />
                                </div>
                              )}
                            </div>
                            <div className="flex flex-col gap-1">
                              <span className="text-xs text-muted-foreground uppercase tracking-wider">
                                Chromatograph BG
                              </span>
                              {lookupResult.coa.chromatograph_background_url ? (
                                <div className="h-12 w-20 rounded border bg-white flex items-center justify-center overflow-hidden">
                                  <img
                                    src={
                                      lookupResult.coa
                                        .chromatograph_background_url
                                    }
                                    alt="Chromatograph background"
                                    className="max-h-full max-w-full object-contain"
                                  />
                                </div>
                              ) : (
                                <div className="h-12 w-20 rounded border bg-muted flex items-center justify-center">
                                  <Image className="h-4 w-4 text-muted-foreground opacity-40" />
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </details>
                    </CardContent>
                  </Card>
                )}

                {/* Photograph + Check-In */}
                {lookupResult && !lookupLoading && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <PhotoCapture
                      capturedUrl={capturedPhotoUrl}
                      onCapture={setCapturedPhotoUrl}
                      onClear={() => {
                        setCapturedPhotoUrl(null)
                        setReceiveResult(null)
                        setReceiveError(null)
                      }}
                    />

                    {/* Check-In Sample to SENAITE */}
                    {selectedSample && (
                      <Card>
                        <CardHeader className="pb-3">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <ClipboardCheck className="h-4 w-4 text-blue-500 dark:text-slate-400" />
                            Check-In Sample to SENAITE
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-4">
                          <InlineField
                            label="Sample ID"
                            value={selectedSample.id}
                          />
                          <div className="flex flex-col gap-1.5">
                            <label
                              htmlFor="remarks"
                              className="text-xs text-muted-foreground uppercase tracking-wider"
                            >
                              Remarks
                            </label>
                            <textarea
                              id="remarks"
                              value={remarks}
                              onChange={e => setRemarks(e.target.value)}
                              placeholder="Optional remarks for this sample..."
                              disabled={receiveResult?.success === true}
                              rows={3}
                              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                            />
                          </div>

                          <Button
                            onClick={() => void handleReceiveSample()}
                            disabled={
                              !capturedPhotoUrl ||
                              receiveLoading ||
                              receiveResult?.success === true
                            }
                            className="w-full"
                          >
                            {receiveLoading ? (
                              <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Receiving...
                              </>
                            ) : receiveResult?.success ? (
                              <>
                                <Check className="h-4 w-4" />
                                Received
                              </>
                            ) : (
                              <>
                                <ClipboardCheck className="h-4 w-4" />
                                Receive Sample
                              </>
                            )}
                          </Button>

                          {receiveResult && !receiveResult.success && (
                            <Alert variant="destructive">
                              <AlertDescription>
                                {receiveResult.message}
                              </AlertDescription>
                            </Alert>
                          )}

                          {receiveResult?.success && (
                            <Alert>
                              <Check className="h-4 w-4" />
                              <AlertDescription>
                                {receiveResult.message}
                              </AlertDescription>
                            </Alert>
                          )}

                          {receiveError && (
                            <Alert variant="destructive">
                              <AlertDescription>
                                {receiveError}
                              </AlertDescription>
                            </Alert>
                          )}

                          {/* Debug response box */}
                          {(receiveResult?.senaite_response ||
                            receiveError) && (
                            <details className="text-xs">
                              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                                SENAITE Response
                              </summary>
                              <pre className="mt-2 max-h-64 overflow-auto rounded border bg-muted/50 p-3 font-mono">
                                {receiveResult?.senaite_response
                                  ? JSON.stringify(
                                      receiveResult.senaite_response,
                                      null,
                                      2
                                    )
                                  : receiveError}
                              </pre>
                            </details>
                          )}
                        </CardContent>
                      </Card>
                    )}
                  </div>
                )}
              </div>
            )}

          </div>
        </ScrollArea>

        {/* Navigation footer */}
        <div className="flex shrink-0 items-center justify-between border-t p-4">
          <Button
            variant="outline"
            onClick={handleBack}
            disabled={currentStep === 1}
          >
            Back
          </Button>
          {currentStep < 2 && (
            <Button onClick={handleNext} disabled={!canGoNext}>
              Next Step
            </Button>
          )}
          {currentStep === 2 && receiveResult?.success && (
            <Button onClick={handleCheckInAnother}>
              <RotateCcw className="h-4 w-4" />
              Check In Another Sample
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
