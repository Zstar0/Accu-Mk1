import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Lock } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  getVarianceSet,
  patchVarianceMembership,
  lockVarianceSet,
  unlockVarianceSet,
  promoteAnalyses,
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
        <DialogHeader>
          <DialogTitle className="text-lg">{parentSampleId} — Variance Summary</DialogTitle>
        </DialogHeader>
        <VarianceSummaryBody parentSampleId={parentSampleId} />
      </DialogContent>
    </Dialog>
  )
}

function VarianceSummaryBody({ parentSampleId }: { parentSampleId: string }) {
  const queryClient = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['variance-set', parentSampleId],
    queryFn: () => getVarianceSet(parentSampleId),
    enabled: !!parentSampleId,
  })

  const membership = useMutation({
    mutationFn: patchVarianceMembership,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['variance-set', parentSampleId] }),
    onError: (e: Error) => toast.error('Failed to update vial', { description: e.message }),
  })

  const lock = useMutation({
    mutationFn: () => lockVarianceSet(parentSampleId),
    onSuccess: () => {
      toast.success('Variance set locked')
      queryClient.invalidateQueries({ queryKey: ['variance-set', parentSampleId] })
    },
    onError: (e: Error) => toast.error('Could not lock', { description: e.message }),
  })

  const unlock = useMutation({
    mutationFn: () => unlockVarianceSet(parentSampleId),
    onSuccess: () => {
      toast.success('Variance set unlocked')
      queryClient.invalidateQueries({ queryKey: ['variance-set', parentSampleId] })
    },
    onError: (e: Error) => toast.error('Could not unlock', { description: e.message }),
  })

  if (isLoading)
    return <div className="p-8 flex justify-center"><Loader2 className="animate-spin" /></div>
  if (isError)
    return <div className="p-6 text-red-600 text-sm">Error: {(error as Error)?.message}</div>
  if (!data) return null

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
            Locked at {new Date(data.locked_at!).toLocaleString()} by user #{data.locked_by_user_id}.
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
                  {stat.spec ? JSON.stringify(stat.spec) : '—'}
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
  vial, locked, onToggle, onReasonChange,
}: {
  vial: VarianceVial
  locked: boolean
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
        {vial.is_parent ? `Vial 1 (parent)` : `Vial ${vial.vial_sequence + 1}`}
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
