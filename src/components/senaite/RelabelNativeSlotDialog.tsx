import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Check } from 'lucide-react'
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
  relabelNativeSlot,
} from '@/lib/api'

interface RelabelNativeSlotDialogProps {
  open: boolean
  sampleId: string
  slot: number
  oldPeptideId: number | null
  oldPeptideName: string
  onClose: () => void
  onDone: () => void
}

/**
 * Native-mode sibling of ReplaceAnalyteDialog (SENAITE-only): relabel one
 * occupied slot on an mk1-origin sample via the native-slots relabel route
 * instead of the SENAITE explorer/replace endpoint. Same peptide-list data
 * source and picker UI as ReplaceAnalyteDialog — copied structure rather
 * than sharing a component since the confirm action and error shape differ
 * (409 native_slot_locked / duplicate_peptide / peptide_not_found here vs.
 * the 412 retract-confirm flow there).
 */
export function RelabelNativeSlotDialog({
  open,
  sampleId,
  slot,
  oldPeptideId,
  oldPeptideName,
  onClose,
  onDone,
}: RelabelNativeSlotDialogProps) {
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)

  const { data: peptides = [], isLoading } = useQuery({
    queryKey: ['peptides'],
    queryFn: () => getPeptides(),
    staleTime: 5 * 60 * 1000,
    enabled: open,
  })

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return peptides
      .filter(p => p.active && !p.is_blend && p.id !== oldPeptideId)
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.abbreviation.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [peptides, search, oldPeptideId])

  function reset() {
    setSearch('')
    setSelectedId(null)
    setReason('')
    setPending(false)
  }

  async function doRelabel() {
    if (selectedId == null) return
    setPending(true)
    try {
      const result = await relabelNativeSlot(sampleId, slot, selectedId, reason || undefined)
      toast.success(`Slot ${result.slot} relabeled`, {
        description: result.restamped ? 'Vial rows restamped' : undefined,
      })
      reset()
      onDone()
      onClose()
    } catch (e) {
      toast.error('Relabel failed', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) { reset(); onClose() } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Relabel analyte {slot} — {oldPeptideName}</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground -mt-1">
          Pick the correct peptide for this native-born slot.
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
            const selected = p.id === selectedId
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={cn(
                  'w-full flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted/60 cursor-pointer',
                  selected ? 'bg-primary/10 border border-primary/40' : 'border border-transparent',
                )}
              >
                <span className="truncate">{p.name}</span>
                {selected && <Check size={14} className="text-primary shrink-0" />}
              </button>
            )
          })}
          {!isLoading && rows.length === 0 && (
            <p className="text-xs text-muted-foreground px-2 py-3">No matching peptides.</p>
          )}
          {isLoading && (
            <p className="text-xs text-muted-foreground px-2 py-3">Loading peptides…</p>
          )}
        </div>

        <input
          type="text"
          placeholder="Reason (optional)"
          value={reason}
          onChange={e => setReason(e.target.value)}
          className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />

        <DialogFooter>
          <Button variant="ghost" onClick={() => { reset(); onClose() }} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={doRelabel} disabled={selectedId == null || pending}>
            {pending ? 'Relabeling…' : 'Relabel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
