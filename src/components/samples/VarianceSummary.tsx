import { useState, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronRight, Clock, Loader2, Lock } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { VarianceHelp, VarianceHelpCard } from '@/components/samples/VarianceHelp'
import { specText } from '@/components/senaite/AnalysisSpecCell'
import { cn } from '@/lib/utils'
import { vialLabel } from '@/lib/vial-label'
import {
  formatRunValueWithUnit,
  lockProblems,
  statSpecText,
} from '@/lib/variance-values'
import {
  getVarianceSet,
  patchVarianceMembership,
  lockVarianceSet,
  unlockVarianceSet,
  promoteAnalyses,
  type VarianceRun,
  type VarianceSetResponse,
  type VarianceTest,
  type VarianceVial,
  type VarianceStatsEntry,
} from '@/lib/api'

interface Props {
  parentSampleId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

function StatCell({ stat }: { stat: VarianceStatsEntry }) {
  if (stat.kind === 'categorical') {
    return <span>{stat.conforms_count ?? 0} of {stat.total ?? 0} conform</span>
  }
  if (stat.mean === null) return <span className="text-muted-foreground">—</span>
  const parts: string[] = [`Mean ${stat.mean.toFixed(2)}`]
  if (stat.sd !== null) parts.push(`SD ${stat.sd.toFixed(2)}`)
  if (stat.cv_pct !== null) parts.push(`CV ${stat.cv_pct.toFixed(2)}%`)
  parts.push(`n=${stat.n}`)
  return <span>{parts.join(' · ')}</span>
}

function PassBadge({ pass }: { pass: boolean | null }) {
  if (pass === null) return <span className="text-muted-foreground">—</span>
  return pass
    ? <span className="text-green-700 font-medium">✓ PASS</span>
    : <span className="text-red-700 font-medium">✗ FAIL</span>
}

export function VarianceSummary({ parentSampleId, open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl sm:max-w-5xl w-[95vw] max-h-[90vh] overflow-y-auto">
        <VarianceSummaryBody parentSampleId={parentSampleId} />
      </DialogContent>
    </Dialog>
  )
}

function useVarianceMutations(parentSampleId: string, onLockRefused: (message: string | null) => void) {
  const queryClient = useQueryClient()
  const membership = useMutation({
    mutationFn: patchVarianceMembership,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['variance-set', parentSampleId] }),
    onError: (e: Error) => toast.error('Failed to update vial', { description: e.message }),
  })

  const lock = useMutation({
    mutationFn: () => lockVarianceSet(parentSampleId),
    onSuccess: () => {
      onLockRefused(null)
      toast.success('Variance set locked')
      queryClient.invalidateQueries({ queryKey: ['variance-set', parentSampleId] })
    },
    onError: (e: Error) => {
      onLockRefused(e.message)
      toast.error('Could not lock', { description: e.message })
    },
  })

  const unlock = useMutation({
    mutationFn: () => unlockVarianceSet(parentSampleId),
    onSuccess: () => {
      toast.success('Variance set unlocked')
      queryClient.invalidateQueries({ queryKey: ['variance-set', parentSampleId] })
    },
    onError: (e: Error) => toast.error('Could not unlock', { description: e.message }),
  })
  return { membership, lock, unlock }
}

type VarianceMutations = ReturnType<typeof useVarianceMutations>

function VarianceSummaryBody({ parentSampleId }: { parentSampleId: string }) {
  const [lockRefusal, setLockRefusal] = useState<string | null>(null)
  const mutations = useVarianceMutations(parentSampleId, setLockRefusal)
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['variance-set', parentSampleId],
    queryFn: () => getVarianceSet(parentSampleId),
    enabled: !!parentSampleId,
  })

  // Container families get the per-test body; legacy families (the parent is
  // vial 1 and appears in the list) keep the original body.
  const containerBody = !!data?.parent.container_mode && !data.vials.some(v => v.is_parent)
  return (
    <>
      <DialogHeader>
        {containerBody ? (
          <DialogTitle className="text-lg flex items-center gap-1.5">
            {parentSampleId} · Variance
            <VarianceHelp id="overview" />
          </DialogTitle>
        ) : (
          <DialogTitle className="text-lg">{parentSampleId} — Variance Summary</DialogTitle>
        )}
      </DialogHeader>
      {isLoading ? (
        <div className="p-8 flex justify-center"><Loader2 className="animate-spin" /></div>
      ) : isError ? (
        <div className="p-6 text-red-600 text-sm">Error: {(error as Error)?.message}</div>
      ) : !data ? null : containerBody ? (
        <ContainerVarianceBody
          parentSampleId={parentSampleId}
          data={data}
          mutations={mutations}
          lockRefusal={lockRefusal}
        />
      ) : (
        <LegacyVarianceBody parentSampleId={parentSampleId} data={data} mutations={mutations} />
      )}
    </>
  )
}

/** The original body, for legacy (SENAITE-era) families. Unchanged apart
 *  from the locker's name and a readable Spec cell. */
function LegacyVarianceBody({
  parentSampleId,
  data,
  mutations,
}: {
  parentSampleId: string
  data: VarianceSetResponse
  mutations: VarianceMutations
}) {
  const queryClient = useQueryClient()
  const { membership, lock, unlock } = mutations

  const selectedCount =
    (data.vials.find(v => v.is_parent)?.in_variance_set ? 1 : 0) +
    data.vials.filter(v => !v.is_parent && v.in_variance_set).length

  const allSelected = data.vials.every(v => v.in_variance_set)
  const noneSelected = data.vials.every(v => !v.in_variance_set)
  const locked = data.locked

  const setAll = (val: boolean) => {
    data.vials.forEach(v => {
      if (v.in_variance_set !== val) {
        membership.mutate({ sampleId: v.sample_id, inVarianceSet: val })
      }
    })
  }

  return (
    <div className="space-y-5 pt-2">
      <p className="text-sm text-muted-foreground">
        {data.vials.length} vials in family · {selectedCount} in variance set
      </p>

      {locked && (
        <div className="rounded-md border-2 border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200 p-3 text-sm flex items-center gap-2">
          <Lock className="w-4 h-4" />
          <span className="flex-1">
            Locked at {new Date(data.locked_at!).toLocaleString()} by {data.locked_by_name ?? `user #${data.locked_by_user_id}`}.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => unlock.mutate()}
            disabled={unlock.isPending}
          >
            Unlock
          </Button>
        </div>
      )}

      <section className="border rounded-md">
        <header className="px-4 py-2 border-b font-semibold text-sm bg-muted/50">
          Select which vials participate in variance
        </header>
        <ul className="divide-y">
          {data.vials.map(v => (
            <VialRow
              key={v.sample_id}
              vial={v}
              locked={locked}
              containerMode={data.parent.container_mode ?? false}
              onToggle={(checked) =>
                membership.mutate({
                  sampleId: v.sample_id,
                  inVarianceSet: checked,
                  exclusionReason: !checked ? v.exclusion_reason ?? null : null,
                })
              }
              onReasonChange={(reason) =>
                membership.mutate({
                  sampleId: v.sample_id,
                  inVarianceSet: false,
                  exclusionReason: reason,
                })
              }
            />
          ))}
        </ul>
        <footer className="px-4 py-2 border-t flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setAll(true)} disabled={allSelected || locked}>
            Select all
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAll(false)} disabled={noneSelected || locked}>
            Clear all
          </Button>
        </footer>
      </section>

      <section className="border rounded-md">
        <header className="px-4 py-2 border-b font-semibold text-sm bg-muted/50">
          Computed across selected (n={selectedCount})
        </header>
        <table className="w-full text-sm">
          <thead className="bg-muted/30">
            <tr>
              <th className="p-2 text-left font-medium">Analysis</th>
              <th className="p-2 text-left font-medium">Stats</th>
              <th className="p-2 text-left font-medium">Spec</th>
              <th className="p-2 text-left font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.stats).map(([kw, stat]) => (
              <tr key={kw} className="border-t">
                <td className="p-2 font-medium">{kw}</td>
                <td className="p-2"><StatCell stat={stat} /></td>
                <td className="p-2 text-muted-foreground">
                  {statSpecText(stat.spec)}
                </td>
                <td className="p-2"><PassBadge pass={stat.pass} /></td>
              </tr>
            ))}
            {Object.keys(data.stats).length === 0 && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-muted-foreground text-sm">
                  No results entered yet — stats will populate as vial results land.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <div className="flex items-center gap-3">
        <Button
          onClick={() => lock.mutate()}
          disabled={selectedCount < 2 || locked || lock.isPending}
          className="gap-2"
        >
          <Lock className="w-4 h-4" />
          Lock variance set
        </Button>
        {selectedCount < 2 && !locked && (
          <span className="text-xs text-muted-foreground">
            Need ≥2 selected vials to lock.
          </span>
        )}
      </div>

      {locked && (
        <PromoteStage
          parentSampleId={parentSampleId}
          vials={data.vials}
          stats={data.stats}
          onPromoted={() => queryClient.invalidateQueries({ queryKey: ['variance-set', parentSampleId] })}
        />
      )}
    </div>
  )
}

function VialRow({
  vial, locked, containerMode, onToggle, onReasonChange,
}: {
  vial: VarianceVial
  locked: boolean
  /** Container family: S01 IS Vial 1 (parent rows never occur — the backend
   *  omits the parent from container variance sets). */
  containerMode: boolean
  onToggle: (checked: boolean) => void
  onReasonChange: (reason: string) => void
}) {
  const [reason, setReason] = useState(vial.exclusion_reason ?? '')
  return (
    <li className="px-4 py-2 flex items-center gap-3 text-sm">
      <Checkbox
        checked={vial.in_variance_set}
        disabled={locked}
        onCheckedChange={(c) => onToggle(Boolean(c))}
      />
      <code className="min-w-[10rem]">{vial.sample_id}</code>
      <span className="min-w-[8rem] text-muted-foreground">
        {vial.is_parent ? `Vial 1 (parent)` : vialLabel(vial.vial_sequence, containerMode)}
      </span>
      <span className="flex-1 text-muted-foreground text-xs">
        {Object.entries(vial.results).length === 0
          ? '— no results yet'
          : Object.entries(vial.results).map(([k, r]) =>
              <span key={k} className="mr-3">{k}: {String(r.value ?? '—')}</span>
            )}
      </span>
      {!vial.in_variance_set && (
        <input
          type="text"
          placeholder="reason"
          value={reason}
          disabled={locked}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => {
            if (reason !== (vial.exclusion_reason ?? '')) {
              onReasonChange(reason)
            }
          }}
          className="text-xs px-2 py-1 border rounded w-40 bg-background"
        />
      )}
    </li>
  )
}


// ─── Container families: one card per test ──────────────────────────────────

/** Counted runs, as the server counts them: an add-on test's core run always,
 *  otherwise (replicates, and every HPLC vial) only when in the set. */
function countedRuns(test: VarianceTest): VarianceRun[] {
  return test.runs.filter(r => r.in_variance_set || (r.kind !== 'variance' && !test.is_hplc))
}

function StatusItem({ done, label }: { done: boolean; label: string }) {
  return (
    <span
      data-testid="variance-status-item"
      data-done={done}
      className={cn(
        'inline-flex items-center gap-1',
        done ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
      )}
    >
      {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Clock className="h-3.5 w-3.5" aria-hidden="true" />}
      {label}
    </span>
  )
}

/** A control that is greyed out while the set is locked, with a hover that
 *  says why. The span carries the hover (a disabled button gets no pointer
 *  events). */
function LockedHint({ locked, children }: { locked: boolean; children: ReactNode }) {
  if (!locked) return <>{children}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex" aria-label="Unlock the set to change this">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="p-0 max-w-xs">
        <VarianceHelpCard id="greyed_out" />
      </TooltipContent>
    </Tooltip>
  )
}

function ContainerVarianceBody({
  parentSampleId,
  data,
  mutations,
  lockRefusal,
}: {
  parentSampleId: string
  data: VarianceSetResponse
  mutations: VarianceMutations
  lockRefusal: string | null
}) {
  const queryClient = useQueryClient()
  const { membership, lock, unlock } = mutations
  const tests = data.tests ?? []
  const locked = data.locked
  const counted = tests.flatMap(countedRuns)
  const replicates = counted.filter(r => r.kind === 'variance')
  const resultsIn = counted.length > 0 && counted.every(r => r.has_result)
  const signedOff = replicates.length > 0 && replicates.every(r => r.signed_off)
  // Same enablement as the original body (container sets list vials only):
  // every in-set vial counts, including the ones in no test card below.
  const selectedCount = data.vials.filter(v => !v.is_parent && v.in_variance_set).length
  const inCards = new Set(tests.flatMap(t => t.runs.map(r => r.sample_id)))
  const otherVials = data.vials.filter(v => !v.is_parent && !inCards.has(v.sample_id))
  const problems = lockRefusal ? lockProblems(lockRefusal) : []

  return (
    <div className="space-y-4 pt-1">
      <div data-testid="variance-status" className="flex items-center gap-4 text-sm flex-wrap">
        <StatusItem done={resultsIn} label="Results in" />
        <StatusItem done={signedOff} label="Signed off" />
        <StatusItem done={locked} label={locked ? 'Locked' : 'Not locked'} />
        <VarianceHelp id="status" />
      </div>

      {locked && (
        <div className="rounded-md border-2 border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200 p-3 text-sm flex items-center gap-2">
          <Lock className="w-4 h-4" />
          <span className="flex-1 inline-flex items-center gap-1.5">
            Locked {data.locked_at ? new Date(data.locked_at).toLocaleString() : ''} by{' '}
            {data.locked_by_name ?? `user #${data.locked_by_user_id}`}
            <VarianceHelp id="lock_banner" />
          </span>
          <Button variant="outline" size="sm" onClick={() => unlock.mutate()} disabled={unlock.isPending}>
            Unlock
          </Button>
        </div>
      )}

      {problems.length > 0 && !locked && (
        <div
          role="alert"
          data-testid="variance-lock-refusal"
          className="rounded-md border border-red-300 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-950/30 dark:text-red-200 p-3 text-sm"
        >
          <div className="font-medium mb-1">The set cannot lock yet:</div>
          <ul className="list-disc pl-5 space-y-0.5">
            {problems.map(p => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}

      {tests.map(test => (
        <TestCard
          key={test.role}
          test={test}
          locked={locked}
          data={data}
          parentSampleId={parentSampleId}
          onMembership={args => membership.mutate(args)}
          membershipPending={membership.isPending}
          onPromoted={() => queryClient.invalidateQueries({ queryKey: ['variance-set', parentSampleId] })}
        />
      ))}
      {tests.length === 0 && (
        <p className="text-sm text-muted-foreground">No test on this sample has a replicate vial yet.</p>
      )}
      {otherVials.length > 0 && (
        <OtherVials
          vials={otherVials}
          locked={locked}
          pending={membership.isPending}
          onMembership={args => membership.mutate(args)}
        />
      )}

      <div className="flex items-center gap-3">
        <Button
          onClick={() => lock.mutate()}
          disabled={selectedCount < 2 || locked || lock.isPending}
          className="gap-2"
        >
          <Lock className="w-4 h-4" />
          Lock variance set
        </Button>
        <VarianceHelp id="lock_button" />
        {selectedCount < 2 && !locked && (
          <span className="text-xs text-muted-foreground">Needs at least 2 vials in the set to lock.</span>
        )}
      </div>
    </div>
  )
}

function TestCard({
  test,
  locked,
  data,
  parentSampleId,
  onMembership,
  membershipPending,
  onPromoted,
}: {
  test: VarianceTest
  locked: boolean
  data: VarianceSetResponse
  parentSampleId: string
  onMembership: (args: { sampleId: string; inVarianceSet: boolean; exclusionReason?: string | null }) => void
  membershipPending: boolean
  onPromoted: () => void
}) {
  const [reportedOpen, setReportedOpen] = useState(false)
  const firstSpec = test.is_hplc
    ? null
    : test.runs.flatMap(r => r.values).find(v => v.specification)?.specification ?? null
  const oneAnalysis = test.runs.every(r => r.values.length <= 1)
  const replicateIds = test.runs.filter(r => r.kind === 'variance').map(r => r.sample_id)
  return (
    <section data-testid={`variance-test-card-${test.role}`} className="border rounded-md">
      <header className="px-4 py-2 border-b bg-muted/50 flex items-center gap-2 text-sm">
        <span className="font-semibold">{test.title}</span>
        <VarianceHelp id="test_card" />
        <span className="text-muted-foreground">{test.runs.length} runs</span>
        {firstSpec && oneAnalysis && (
          <span className="ml-auto text-xs font-mono text-muted-foreground">Spec {specText(firstSpec)}</span>
        )}
      </header>
      <table className="w-full text-sm">
        <thead className="bg-muted/30 text-xs text-muted-foreground">
          <tr>
            <th className="p-2 text-left font-medium">
              <span className="inline-flex items-center gap-1">Run <VarianceHelp id="replicate" /></span>
            </th>
            <th className="p-2 text-left font-medium">Vial</th>
            <th className="p-2 text-left font-medium">Result</th>
            <th className="p-2 text-left font-medium">
              <span className="inline-flex items-center gap-1">Signed off <VarianceHelp id="signoff" /></span>
            </th>
            <th className="p-2 text-left font-medium">
              <span className="inline-flex items-center gap-1">Counts <VarianceHelp id="include" /></span>
            </th>
          </tr>
        </thead>
        <tbody>
          {test.runs.map(run => {
            const isCore = run.kind !== 'variance'
            return (
              <RunRow
                key={run.sample_id}
                run={run}
                label={isCore ? 'Core' : `Variance ${replicateIds.indexOf(run.sample_id) + 1}`}
                alwaysCounts={isCore && !test.is_hplc}
                locked={locked}
                pending={membershipPending}
                onMembership={onMembership}
              />
            )
          })}
        </tbody>
      </table>
      <footer data-testid="variance-card-footer" className="px-4 py-2 border-t text-sm flex items-start gap-2 flex-wrap">
        {test.is_hplc ? (
          <>
            <div className="flex flex-col gap-0.5">
              {test.summary.stats.map(s => (
                <span key={s.keyword}>
                  <span className="text-muted-foreground">{s.label ?? s.keyword}: </span>
                  {s.kind === 'categorical'
                    ? `${s.conforms_count ?? 0} of ${s.total ?? 0} conform`
                    : s.mean === null
                      ? '–'
                      : [
                          `Mean ${s.mean.toFixed(2)}`,
                          s.sd !== null ? `SD ${s.sd.toFixed(2)}` : null,
                          s.cv_pct !== null ? `CV ${s.cv_pct.toFixed(2)}%` : null,
                          `n=${s.n}`,
                        ].filter(Boolean).join(' · ')}
                </span>
              ))}
              {test.summary.stats.length === 0 && <span className="text-muted-foreground">No results yet.</span>}
            </div>
            <VarianceHelp id="footer_hplc" />
          </>
        ) : (
          <>
            <span>{test.summary.conforming} of {test.summary.runs} within spec</span>
            <VarianceHelp id="footer_addon" />
          </>
        )}
      </footer>
      {test.is_hplc && (
        <div className="border-t">
          <button
            type="button"
            aria-expanded={reportedOpen}
            onClick={() => setReportedOpen(o => !o)}
            className="w-full px-4 py-2 text-sm flex items-center gap-1.5 text-left cursor-pointer hover:bg-muted/30"
          >
            {reportedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Reported value
            <VarianceHelp id="reported_value" />
          </button>
          {reportedOpen && (
            <div className="px-4 pb-3">
              {locked ? (
                <PromoteStage
                  parentSampleId={parentSampleId}
                  vials={data.vials}
                  stats={hplcStats(test, data.stats)}
                  onPromoted={onPromoted}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Lock the set to choose the reported value.</p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** Today's stats, narrowed to this HPLC test's analyses: Promote is never
 *  offered for an add-on test (the parent already holds its core run). */
function hplcStats(test: VarianceTest, stats: Record<string, VarianceStatsEntry>) {
  const keys = new Set(test.runs.flatMap(r => r.values.map(v => v.keyword)))
  return Object.fromEntries(Object.entries(stats).filter(([k]) => keys.has(k)))
}

type OnMembership = (args: { sampleId: string; inVarianceSet: boolean; exclusionReason?: string | null }) => void

/** Include or exclude one vial from the set. Excluding asks for a reason
 *  first; greyed out while the set is locked. */
function IncludeControl({
  sampleId,
  inSet,
  exclusionReason,
  locked,
  pending,
  onMembership,
}: {
  sampleId: string
  inSet: boolean
  exclusionReason: string | null
  locked: boolean
  pending: boolean
  onMembership: OnMembership
}) {
  const [reason, setReason] = useState<string | null>(null) // non-null: asking for a reason
  if (reason !== null && !locked) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <input
          type="text"
          autoFocus
          aria-label={`Reason for excluding ${sampleId}`}
          placeholder="Reason (required)"
          value={reason}
          onChange={e => setReason(e.target.value)}
          className="text-xs px-2 py-1 border rounded w-44 bg-background"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!reason.trim() || pending}
          onClick={() => {
            onMembership({ sampleId, inVarianceSet: false, exclusionReason: reason.trim() })
            setReason(null)
          }}
        >
          Exclude
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setReason(null)}>
          Cancel
        </Button>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className={inSet ? 'text-foreground' : 'text-muted-foreground'}>
        {inSet ? 'Included' : 'Excluded'}
        {!inSet && exclusionReason ? `: ${exclusionReason}` : ''}
      </span>
      <LockedHint locked={locked}>
        <Button
          size="sm"
          variant="outline"
          disabled={locked || pending}
          onClick={() =>
            inSet
              ? setReason('')
              : onMembership({ sampleId, inVarianceSet: true, exclusionReason: null })
          }
        >
          {inSet ? 'Exclude' : 'Include'}
        </Button>
      </LockedHint>
    </span>
  )
}

/** Vials that sit in no test card (e.g. a test bought without Variance).
 *  Shown because an in-set one still counts toward the lock's minimum. */
function OtherVials({
  vials,
  locked,
  pending,
  onMembership,
}: {
  vials: VarianceVial[]
  locked: boolean
  pending: boolean
  onMembership: OnMembership
}) {
  const [open, setOpen] = useState(false)
  const inSet = vials.filter(v => v.in_variance_set).length
  return (
    <section data-testid="variance-other-vials" className="border rounded-md">
      <div className="flex items-center gap-1.5 px-4 py-2 text-sm">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
          className="inline-flex items-center gap-1.5 text-left cursor-pointer hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="font-semibold">Other vials</span>
          <span className="text-muted-foreground">
            {vials.length} · {inSet} in the set
          </span>
        </button>
        <VarianceHelp id="other_vials" />
      </div>
      {open && (
        <table className="w-full text-sm border-t">
          <tbody>
            {vials.map(v => {
              const results = Object.entries(v.results)
              return (
                <tr
                  key={v.sample_id}
                  data-testid={`variance-other-${v.sample_id}`}
                  className={cn('border-t first:border-t-0', !v.in_variance_set && 'text-muted-foreground')}
                >
                  <td className="p-2 font-mono whitespace-nowrap">{v.sample_id}</td>
                  <td className="p-2 whitespace-nowrap">{vialLabel(v.vial_sequence, true)}</td>
                  <td className="p-2">
                    {results.length === 0
                      ? <span className="text-muted-foreground">No results yet</span>
                      : results.map(([k, r]) => `${k}: ${String(r.value ?? '–')}`).join(' · ')}
                  </td>
                  <td className="p-2">
                    <IncludeControl
                      sampleId={v.sample_id}
                      inSet={v.in_variance_set}
                      exclusionReason={v.exclusion_reason}
                      locked={locked}
                      pending={pending}
                      onMembership={onMembership}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

function RunRow({
  run,
  label,
  alwaysCounts,
  locked,
  pending,
  onMembership,
}: {
  run: VarianceRun
  label: string
  /** The core run of an add-on test: counted regardless of the set. */
  alwaysCounts: boolean
  locked: boolean
  pending: boolean
  onMembership: OnMembership
}) {
  const excluded = !alwaysCounts && !run.in_variance_set
  const lastSegment = run.sample_id.split('-').pop()
  return (
    <tr data-testid={`variance-run-${run.sample_id}`} className={cn('border-t', excluded && 'text-muted-foreground')}>
      <td className="p-2 font-medium whitespace-nowrap">{label}</td>
      <td className="p-2 whitespace-nowrap">Vial {run.vial_sequence} · {lastSegment}</td>
      <td className="p-2">
        {run.has_result ? (
          run.values.map(formatRunValueWithUnit).join(' · ')
        ) : (
          <span className="text-amber-600 dark:text-amber-400">pending</span>
        )}
      </td>
      <td className="p-2 whitespace-nowrap">
        {run.signed_off ? (
          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <Check className="h-3.5 w-3.5" aria-hidden="true" /> Signed off
          </span>
        ) : (
          <span className="text-muted-foreground">Not yet</span>
        )}
      </td>
      <td className="p-2">
        {alwaysCounts ? (
          <span data-testid="variance-core-always" className="inline-flex items-center gap-1">
            <Lock className="h-3.5 w-3.5" aria-hidden="true" /> Always
            <VarianceHelp id="core" />
          </span>
        ) : (
          <IncludeControl
            sampleId={run.sample_id}
            inSet={run.in_variance_set}
            exclusionReason={run.exclusion_reason}
            locked={locked}
            pending={pending}
            onMembership={onMembership}
          />
        )}
      </td>
    </tr>
  )
}

// ─── Phase 4b: Promote stage (post-lock) ────────────────────────────────────

function PromoteStage({
  parentSampleId,
  vials,
  stats,
  onPromoted,
}: {
  parentSampleId: string
  vials: VarianceVial[]
  stats: Record<string, VarianceStatsEntry>
  onPromoted: () => void
}) {
  const inSet = vials.filter(v => v.in_variance_set)
  return (
    <section className="border rounded-md">
      <header className="px-4 py-2 border-b font-semibold text-sm bg-muted/50">
        Promote variance results to parent {parentSampleId}
      </header>
      <ul className="divide-y">
        {Object.entries(stats).map(([keyword, stat]) => (
          <PromoteAnalyteRow
            key={keyword}
            keyword={keyword}
            stat={stat}
            vials={inSet}
            onPromoted={onPromoted}
          />
        ))}
        {Object.keys(stats).length === 0 && (
          <li className="p-4 text-center text-muted-foreground text-sm">
            No analyte stats — no vials in the variance set, or no results entered.
          </li>
        )}
      </ul>
    </section>
  )
}

function PromoteAnalyteRow({
  keyword,
  stat,
  vials,
  onPromoted,
}: {
  keyword: string
  stat: VarianceStatsEntry
  vials: VarianceVial[]
  onPromoted: () => void
}) {
  // Only Mk1-sourced result entries can be promoted (need uid starting with mk1:).
  // Build a list of (vial, entry, analysis_id) tuples upfront so the entry type
  // is narrowed and we don't re-index v.results[keyword] elsewhere.
  type Eligible = { vial: VarianceVial; value: number | string | null; analysis_id: number; promoted_to_parent_id: number | null | undefined }
  const eligible: Eligible[] = []
  for (const v of vials) {
    const entry = v.results?.[keyword]
    if (entry?.uid && entry.uid.startsWith('mk1:')) {
      eligible.push({
        vial: v,
        value: entry.value,
        analysis_id: parseInt(entry.uid.slice('mk1:'.length), 10),
        promoted_to_parent_id: entry.promoted_to_parent_id,
      })
    }
  }
  const eligibleIds = eligible.map(e => e.analysis_id)

  const meanVal = stat.kind !== 'categorical' && stat.mean !== null
    ? stat.mean.toFixed(2)
    : ''

  const [mode, setMode] = useState<'pick' | 'mean'>('pick')
  const [chosenId, setChosenId] = useState<number | null>(eligibleIds[0] ?? null)
  const [resultValue, setResultValue] = useState<string>(() => {
    const first = eligible[0]
    return first ? String(first.value ?? '') : ''
  })
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)

  // Detect if any of the eligible sources are already promoted — display
  // the badge and skip the picker if so. (Variance set may have been promoted
  // already; the modal should reflect that without offering a re-promote.)
  const promotedSourceParentId = eligible
    .map(e => e.promoted_to_parent_id)
    .find(p => p != null) ?? null

  const handleUseMean = () => {
    setMode('mean')
    setResultValue(meanVal)
    setChosenId(null)
  }
  const handlePickRadio = (id: number) => {
    setMode('pick')
    setChosenId(id)
    const picked = eligible.find(e => e.analysis_id === id)
    if (picked) setResultValue(String(picked.value ?? ''))
  }

  const handlePromote = async () => {
    if (!resultValue || eligibleIds.length === 0) return
    setPending(true)
    try {
      const sources = eligibleIds.map(id => ({
        analysis_id: id,
        contribution_kind:
          mode === 'mean' ? 'aggregated_in' as const :
          id === chosenId ? 'chosen' as const : 'reference' as const,
      }))
      await promoteAnalyses({
        keyword,
        result_value: resultValue,
        sources,
        reason: `Variance promote (${mode === 'mean' ? 'aggregate' : 'pick'})`,
      })
      toast.success(`Promoted ${keyword} to parent`)
      setDone(true)
      onPromoted()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  if (done || promotedSourceParentId != null) {
    return (
      <li className="px-4 py-3 text-sm bg-emerald-50 dark:bg-emerald-950/20">
        <span className="font-medium text-emerald-700 dark:text-emerald-400">
          ✓ {keyword} promoted{promotedSourceParentId != null ? ` → #${promotedSourceParentId}` : ''}
        </span>
      </li>
    )
  }
  if (eligible.length === 0) {
    return (
      <li className="px-4 py-3 text-sm text-muted-foreground">
        {keyword}: no Mk1 vial-tier results to promote
      </li>
    )
  }

  return (
    <li className="px-4 py-3 space-y-2">
      <div className="font-medium text-sm">{keyword}</div>
      <ul className="space-y-1 ml-2">
        {eligible.map(e => (
          <li key={e.vial.sample_id} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`pick-${keyword}`}
              checked={mode === 'pick' && chosenId === e.analysis_id}
              onChange={() => handlePickRadio(e.analysis_id)}
            />
            <code className="min-w-[8rem]">{e.vial.sample_id}</code>
            <span className="text-muted-foreground">
              {String(e.value ?? '—')}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 mt-2">
        {meanVal && (
          <Button
            variant={mode === 'mean' ? 'default' : 'outline'}
            size="sm"
            onClick={handleUseMean}
          >
            Use mean ({meanVal})
          </Button>
        )}
        <input
          type="text"
          value={resultValue}
          onChange={(e) => setResultValue(e.target.value)}
          placeholder="result value"
          className="px-2 py-1 border rounded text-sm font-mono flex-1"
        />
        <Button
          size="sm"
          onClick={handlePromote}
          disabled={pending || !resultValue || (mode === 'pick' && chosenId === null)}
        >
          {pending ? 'Promoting…' : 'Promote'}
        </Button>
      </div>
    </li>
  )
}
