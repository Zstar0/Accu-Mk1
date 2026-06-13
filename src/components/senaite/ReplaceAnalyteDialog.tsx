import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Check, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  getPeptides,
  getPeptidesWithServiceSet,
  replaceAnalyte,
  type RemovalImpact,
} from '@/lib/api'
import { RemovalConfirmModal } from '@/components/senaite/RemovalConfirmModal'

interface ReplaceAnalyteDialogProps {
  open: boolean
  sampleId: string
  senaiteUid: string
  slot: number
  oldPeptideId: number | null
  oldPeptideName: string
  onClose: () => void
  onReplaced: () => void
}

/**
 * Replace the peptide on one analyte slot (wrong-variant correction).
 * Offer-only picker: peptides without a full ID_/PUR_/QTY_ service set are
 * shown disabled. On Replace, posts confirm_retract=false first; a 412 surfaces
 * the retract-confirm modal (worked vial results), 409 means verified rows
 * block the swap.
 */
export function ReplaceAnalyteDialog({
  open,
  sampleId,
  senaiteUid,
  slot,
  oldPeptideId,
  oldPeptideName,
  onClose,
  onReplaced,
}: ReplaceAnalyteDialogProps) {
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const [confirmImpact, setConfirmImpact] = useState<RemovalImpact | null>(null)

  const { data: peptides = [] } = useQuery({
    queryKey: ['peptides'],
    queryFn: () => getPeptides(),
    staleTime: 5 * 60 * 1000,
    enabled: open,
  })
  const { data: eligibleIds = [] } = useQuery({
    queryKey: ['peptides-with-service-set'],
    queryFn: getPeptidesWithServiceSet,
    staleTime: 5 * 60 * 1000,
    enabled: open,
  })
  const eligible = useMemo(() => new Set(eligibleIds), [eligibleIds])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return peptides
      .filter(p => p.active && !p.is_blend && p.id !== oldPeptideId)
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.abbreviation.toLowerCase().includes(q))
      .sort((a, b) => Number(eligible.has(b.id)) - Number(eligible.has(a.id)) || a.name.localeCompare(b.name))
  }, [peptides, search, oldPeptideId, eligible])

  function reset() {
    setSearch('')
    setSelectedId(null)
    setConfirmImpact(null)
    setPending(false)
  }

  async function doReplace(confirmRetract: boolean) {
    if (selectedId == null) return
    setPending(true)
    try {
      const result = await replaceAnalyte(sampleId, slot, {
        newPeptideId: selectedId,
        oldPeptideId: oldPeptideId ?? 0,
        senaiteUid,
        confirmRetract,
      })
      const v = result.vials
      const bits = [
        `${v.reseeded.length} vial${v.reseeded.length === 1 ? '' : 's'} updated`,
        v.retracted.length ? `${v.retracted.length} retracted` : '',
        v.blocked.length ? `${v.blocked.length} blocked` : '',
      ].filter(Boolean)
      toast.success(`Slot ${slot} → ${result.new_peptide}`, { description: bits.join(' · ') })
      reset()
      onReplaced()
      onClose()
    } catch (e) {
      const err = e as Error & { status?: number; impact?: RemovalImpact }
      if (err.status === 412 && err.impact) {
        setConfirmImpact(err.impact)  // worked vial results — ask to retract
      } else {
        toast.error('Replace failed', { description: err.message })
      }
    } finally {
      setPending(false)
    }
  }

  const selectedName = peptides.find(p => p.id === selectedId)?.name ?? ''

  return (
    <>
      <Dialog open={open && confirmImpact === null} onOpenChange={v => { if (!v) { reset(); onClose() } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Replace analyte {slot} — {oldPeptideName}</DialogTitle>
          </DialogHeader>

          <p className="text-sm text-muted-foreground -mt-1">
            Pick the correct peptide. Purity, quantity and identity follow
            automatically and the vials are re-mirrored.
          </p>

          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              type="text"
              placeholder="Search peptides…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div className="max-h-72 overflow-y-auto space-y-0.5 -mx-1 px-1">
            {rows.map(p => {
              const ok = eligible.has(p.id)
              const selected = p.id === selectedId
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={!ok}
                  onClick={() => setSelectedId(p.id)}
                  className={cn(
                    'w-full flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                    selected ? 'bg-primary/10 border border-primary/40' : 'border border-transparent',
                    ok ? 'hover:bg-muted/60 cursor-pointer' : 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <span className="truncate">{p.name}</span>
                  {ok
                    ? (selected && <Check size={14} className="text-primary shrink-0" />)
                    : (
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
                        <AlertCircle size={11} /> no services
                      </span>
                    )}
                </button>
              )
            })}
            {rows.length === 0 && (
              <p className="text-xs text-muted-foreground px-2 py-3">No matching peptides.</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => { reset(); onClose() }} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => doReplace(false)} disabled={selectedId == null || pending}>
              {pending ? 'Replacing…' : 'Replace'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Worked vial results exist → confirm the retract, then re-post. */}
      <RemovalConfirmModal
        open={confirmImpact !== null}
        serviceTitle={`Replace analyte ${slot} → ${selectedName}`}
        impact={confirmImpact}
        pending={pending}
        onConfirm={() => doReplace(true)}
        onCancel={() => setConfirmImpact(null)}
      />
    </>
  )
}
