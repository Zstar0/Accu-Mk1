import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import {
  getMethods,
  stampAnalysisMethodInstrument,
  type HplcMethod,
} from '@/lib/api'

/** Task 7 (methods bench-stamping): per-row method/instrument override for a
 *  native (mk1:) analysis row. Distinct from AnalysisTable's inline
 *  EditableSelectCell pencil-edit (pre-existing, uid/string-uid based) —
 *  this is a Wrench-triggered dialog that writes by numeric analysis id via
 *  stampAnalysisMethodInstrument, and surfaces the endpoint's 409
 *  state_locked guard as a friendly error instead of a raw failure toast. */
export function SetMethodInstrumentDialog({
  analysisId,
  serviceId,
  currentMethodId,
  currentInstrumentId,
  open,
  onOpenChange,
  onSaved,
}: {
  analysisId: number
  serviceId: number
  currentMethodId: number | null
  currentInstrumentId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [coveringMethods, setCoveringMethods] = useState<HplcMethod[]>([])
  const [methodId, setMethodId] = useState<number | null>(null)
  const [instrumentId, setInstrumentId] = useState<number | null>(null)

  // (Re)load methods and reset selections whenever the dialog opens for a
  // (possibly different) row — mirrors PromoteDialog's open-gated reset.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    getMethods()
      .then(all => {
        if (cancelled) return
        const covering = all.filter(
          m =>
            m.active &&
            m.services.some(s => s.analysis_service_id === serviceId)
        )
        setCoveringMethods(covering)

        const defaultMethod = covering.find(m =>
          m.services.some(
            s => s.analysis_service_id === serviceId && s.is_default
          )
        )
        const initialMethodId = currentMethodId ?? defaultMethod?.id ?? null
        setMethodId(initialMethodId)

        const initialMethod =
          covering.find(m => m.id === initialMethodId) ?? null
        const instrumentIds = new Set(
          initialMethod?.instruments.map(i => i.id) ?? []
        )
        setInstrumentId(
          currentInstrumentId != null && instrumentIds.has(currentInstrumentId)
            ? currentInstrumentId
            : null
        )
      })
      .catch(() => {
        if (!cancelled) {
          setCoveringMethods([])
          setMethodId(null)
          setInstrumentId(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, serviceId, currentMethodId, currentInstrumentId])

  const selectedMethod = coveringMethods.find(m => m.id === methodId) ?? null
  const instrumentOptions = selectedMethod?.instruments ?? []

  function handleMethodChange(value: string) {
    const nextMethodId = Number(value)
    setMethodId(nextMethodId)
    const nextMethod = coveringMethods.find(m => m.id === nextMethodId) ?? null
    const stillValid =
      nextMethod?.instruments.some(i => i.id === instrumentId) ?? false
    if (!stillValid) setInstrumentId(null)
  }

  async function handleSave() {
    setPending(true)
    try {
      await stampAnalysisMethodInstrument(analysisId, {
        method_id: methodId,
        instrument_id: instrumentId,
      })
      toast.success('Method/instrument updated')
      onOpenChange(false)
      onSaved()
    } catch (err) {
      const detail = (err as { detail?: { code?: string } } | undefined)?.detail
      if (detail?.code === 'state_locked') {
        toast.error(
          'Result is already reported — corrections go through retract/amend'
        )
      } else {
        toast.error(
          err instanceof Error
            ? err.message
            : 'Failed to update method/instrument'
        )
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set method / instrument</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          {!loading && coveringMethods.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No active methods cover this service.
            </p>
          )}
          <div className="space-y-1.5">
            <label className="text-sm font-medium block">Method</label>
            <Select
              value={methodId != null ? String(methodId) : ''}
              onValueChange={handleMethodChange}
              disabled={loading || coveringMethods.length === 0}
            >
              <SelectTrigger aria-label="Method" className="w-full">
                <SelectValue placeholder="Method…" />
              </SelectTrigger>
              <SelectContent>
                {coveringMethods.map(m => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    {m.code ?? m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium block">Instrument</label>
            <Select
              value={instrumentId != null ? String(instrumentId) : ''}
              onValueChange={value => setInstrumentId(Number(value))}
              disabled={loading || !selectedMethod}
            >
              <SelectTrigger aria-label="Instrument" className="w-full">
                <SelectValue placeholder="Instrument…" />
              </SelectTrigger>
              <SelectContent>
                {instrumentOptions.map(inst => (
                  <SelectItem key={inst.id} value={String(inst.id)}>
                    {inst.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={loading || pending || coveringMethods.length === 0}
          >
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
