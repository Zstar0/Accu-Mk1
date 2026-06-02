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
        <div className="rounded-md border-2 border-amber-400 bg-amber-50 p-3 text-sm flex items-center gap-2">
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
