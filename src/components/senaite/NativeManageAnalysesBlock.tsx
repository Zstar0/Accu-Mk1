/**
 * Native (Accu-Mk1) block inside the Manage Analyses overlay — parent pages only.
 * Spec: docs/superpowers/specs/2026-08-18-native-manage-analyses-design.md §5.1
 *
 * Reads the SAME query the native parent card uses (NATIVE_PARENT_ANALYSES_QUERY_KEY,
 * listNativeParentAnalysesShaped) so list and card can never disagree; adds a
 * profile picker (GET native-profiles), per-row remove (trash, ordered rows only)
 * and an admin-only "Re-sync from order".
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { RemovalConfirmModal } from '@/components/senaite/RemovalConfirmModal'
import { NATIVE_PARENT_ANALYSES_QUERY_KEY } from '@/lib/native-parent-analyses'
import {
  addNativeProfileToParent,
  listNativeParentAnalysesShaped,
  listNativeProfilesForParent,
  NativeRemovalNeedsConfirm,
  removeNativeParentAnalysis,
  resyncParentFromOrder,
  type NativeProfile,
  type RemovalImpact,
  type SenaiteAnalysis,
} from '@/lib/api'

const NATIVE_PROFILES_QUERY_KEY = 'native-profiles'

interface Props {
  sampleId: string
  isAdmin: boolean
  /** Called after any successful mutation so the page can refresh its own state. */
  onChanged: () => void
  /** Optional search string shared with the SENAITE picker. */
  search?: string
}

type NativeRow = SenaiteAnalysis & { provenance?: string | null }

/** senaite-shape rows carry the Mk1 id inside uid ("mk1:144"); NaN when not an mk1 row. */
const mk1IdOf = (r: NativeRow): number => Number((r.uid ?? '').replace(/^mk1:/, ''))

export function NativeManageAnalysesBlock({ sampleId, isAdmin, onChanged, search = '' }: Props) {
  const qc = useQueryClient()
  const rowsQ = useQuery<NativeRow[]>({
    queryKey: [NATIVE_PARENT_ANALYSES_QUERY_KEY, sampleId],
    queryFn: () => listNativeParentAnalysesShaped(sampleId) as Promise<NativeRow[]>,
  })
  const profilesQ = useQuery<NativeProfile[]>({
    queryKey: [NATIVE_PROFILES_QUERY_KEY, sampleId],
    queryFn: () => listNativeProfilesForParent(sampleId),
  })
  const [addingId, setAddingId] = useState<number | null>(null)
  const [removingId, setRemovingId] = useState<number | null>(null)
  const [resyncing, setResyncing] = useState(false)
  const [confirmFor, setConfirmFor] = useState<{ row: NativeRow; impact: RemovalImpact } | null>(null)

  const rows = (rowsQ.data ?? []).filter(r => r.review_state && !['retracted', 'rejected'].includes(r.review_state))
  const profiles = profilesQ.data ?? []
  if (!rowsQ.isLoading && !profilesQ.isLoading && rows.length === 0 && profiles.length === 0) return null

  const roleByServiceKeyword = new Map<string, { role: string | null; hosts: string[] }>()
  for (const p of profiles) for (const m of p.members) roleByServiceKeyword.set(m.keyword, { role: p.fulfillment_role, hosts: p.host_vials })

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: [NATIVE_PARENT_ANALYSES_QUERY_KEY, sampleId] }),
      qc.invalidateQueries({ queryKey: [NATIVE_PROFILES_QUERY_KEY, sampleId] }),
    ])
    onChanged()
  }

  const handleAdd = async (p: NativeProfile) => {
    setAddingId(p.id)
    try {
      const res = await addNativeProfileToParent(sampleId, p.id)
      const hostText = res.no_host_vial
        ? `placeholder only — seeds when a ${p.fulfillment_role ?? '?'} vial is assigned, or use Re-sync`
        : `on ${res.hosts.map(h => h.vial_id).join(', ')}`
      toast.success(`Added ${res.profile_name}`, { description: hostText })
      await invalidate()
    } catch (e) {
      toast.error('Failed to add profile', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setAddingId(null)
    }
  }

  // Task 5 note: on a retest chain the 412 impact can list two worked_unverified
  // rows sharing the same sample_id/keyword (different analysis_id). RemovalConfirmModal
  // only uses these rows for display counts (sample_id/keyword), never as a key, so
  // duplicates render harmlessly in its summary text — no crash risk here.
  const doRemove = async (row: NativeRow, confirm: boolean) => {
    const id = mk1IdOf(row)
    if (!Number.isFinite(id)) return
    setRemovingId(id)
    try {
      const res = await removeNativeParentAnalysis(sampleId, id, confirm)
      toast.success(`Removed ${row.title}`, {
        description: `${res.vial_rows_deleted} vial row(s) deleted, ${res.vial_rows_rejected} rejected`,
      })
      setConfirmFor(null)
      await invalidate()
    } catch (e) {
      if (e instanceof NativeRemovalNeedsConfirm) {
        setConfirmFor({ row, impact: e.impact })
      } else {
        toast.error('Failed to remove analysis', { description: e instanceof Error ? e.message : String(e) })
      }
    } finally {
      setRemovingId(null)
    }
  }

  const handleResync = async () => {
    setResyncing(true)
    try {
      const r = await resyncParentFromOrder(sampleId)
      toast.success('Re-synced from order', {
        description: `${r.placeholders_created} placeholders, ${r.edges_created} edges, ${r.vial_rows_created} vial analyses`,
      })
      await invalidate()
    } catch (e) {
      toast.error('Re-sync failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setResyncing(false)
    }
  }

  const q = search.toLowerCase()
  const pickable = profiles
    .filter(p => p.on_sample !== 'full')
    .filter(p => !q || p.name.toLowerCase().includes(q) || p.key.includes(q) || p.members.some(m => m.keyword.toLowerCase().includes(q)))

  return (
    <div className="mb-4 rounded-md border border-border/60 p-2.5" data-testid="native-manage-block">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium">Native (Accu-Mk1)</p>
        {isAdmin && (
          <Button variant="outline" size="sm" className="h-6 gap-1 text-[11px]" disabled={resyncing} onClick={handleResync}>
            {resyncing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            Re-sync from order
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground mb-1">Current native analyses</p>
      <div className="space-y-1 mb-3">
        {rows.length === 0 && <p className="text-[11px] text-muted-foreground/70 px-2">none</p>}
        {rows.map(r => {
          const id = mk1IdOf(r)
          const isOrdered = r.provenance === 'ordered'
          const host = roleByServiceKeyword.get(r.keyword ?? '')
          const hostChip = host && host.hosts.length > 0 ? `${host.role ?? '?'} · ${host.hosts.join(', ')}` : 'no host vial'
          return (
            <div key={r.uid ?? r.keyword} data-testid="native-row" className="flex items-center justify-between py-1 px-2 rounded bg-muted/40">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-mono text-muted-foreground shrink-0">{r.keyword}</span>
                <span className="text-xs truncate">{r.title}</span>
                <span className="text-[10px] rounded px-1 bg-zinc-500/15 text-zinc-500 shrink-0">{isOrdered ? 'Ordered' : r.review_state}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{hostChip}</span>
              </div>
              <Button
                variant="ghost" size="sm" aria-label={`Remove ${r.title}`}
                className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                disabled={!isOrdered || removingId === id}
                title={isOrdered ? undefined : 'Promoted result — use retest/retract on the card'}
                onClick={() => doRemove(r, false)}
              >
                {removingId === id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              </Button>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-muted-foreground mb-1">Add profile</p>
      <div className="max-h-48 overflow-y-auto space-y-0.5" data-testid="native-profile-picker">
        {profilesQ.isLoading && <Loader2 size={14} className="animate-spin text-muted-foreground m-2" />}
        {pickable.map(p => (
          <div key={p.id} className="flex items-center justify-between py-1 px-2 rounded hover:bg-muted/60">
            <div className="min-w-0">
              <span className="text-xs block">{p.name}{p.on_sample === 'partial' ? ' — adds missing' : ''}</span>
              <span className="text-[10px] font-mono text-muted-foreground block truncate">{p.members.map(m => m.keyword).join(' · ')}</span>
              <span className="text-[10px] text-muted-foreground block">
                {p.host_vials.length > 0 ? `→ ${p.host_vials.join(', ')}` : `no ${p.fulfillment_role ?? '?'} vial yet — placeholder only`}
              </span>
            </div>
            <Button variant="ghost" size="sm" aria-label={`Add ${p.name}`} className="h-6 w-6 p-0 shrink-0" disabled={addingId === p.id} onClick={() => handleAdd(p)}>
              {addingId === p.id ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            </Button>
          </div>
        ))}
        {!profilesQ.isLoading && pickable.length === 0 && <p className="text-[11px] text-muted-foreground/70 px-2">no native profiles to add</p>}
      </div>

      <RemovalConfirmModal
        open={confirmFor !== null}
        serviceTitle={confirmFor?.row.title ?? ''}
        impact={confirmFor?.impact ?? null}
        pending={confirmFor !== null && removingId === mk1IdOf(confirmFor.row)}
        onConfirm={() => confirmFor && doRemove(confirmFor.row, true)}
        onCancel={() => setConfirmFor(null)}
      />
    </div>
  )
}
