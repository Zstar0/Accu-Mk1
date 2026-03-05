import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  createPeptide,
  getAnalysisServices,
  type AnalysisServiceRecord,
  type AnalyteInput,
} from '@/lib/api'

interface PeptideFormProps {
  open: boolean
  onSaved: () => void
  onClose: () => void
}

interface AnalyteSlot {
  analysis_service_id: string // empty string = unselected
}

const EMPTY_SLOT: AnalyteSlot = {
  analysis_service_id: '',
}

export function PeptideForm({ open, onSaved, onClose }: PeptideFormProps) {
  const [name, setName] = useState('')
  const [abbreviation, setAbbreviation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Analyte slots (1-4)
  const [slots, setSlots] = useState<AnalyteSlot[]>([
    { ...EMPTY_SLOT },
    { ...EMPTY_SLOT },
    { ...EMPTY_SLOT },
    { ...EMPTY_SLOT },
  ])

  // Analysis services for dropdown
  const [services, setServices] = useState<AnalysisServiceRecord[]>([])
  const [loadingServices, setLoadingServices] = useState(false)

  // Load Peptide Identity services when sheet opens
  useEffect(() => {
    if (!open) return
    setLoadingServices(true)
    getAnalysisServices({ category: 'Peptide Identity' })
      .then(all => all.filter(s => s.title.includes('Identity (HPLC)')))
      .then(setServices)
      .catch(console.error)
      .finally(() => setLoadingServices(false))
  }, [open])

  // Reset form when sheet closes
  useEffect(() => {
    if (!open) {
      setName('')
      setAbbreviation('')
      setSlots([{ ...EMPTY_SLOT }, { ...EMPTY_SLOT }, { ...EMPTY_SLOT }, { ...EMPTY_SLOT }])
      setError(null)
      setSaving(false)
    }
  }, [open])

  const updateSlot = (index: number, updates: Partial<AnalyteSlot>) => {
    setSlots(prev => prev.map((s, i) => (i === index ? { ...s, ...updates } : s)))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !abbreviation.trim()) return

    // Build analytes array from non-empty slots
    const analytes: AnalyteInput[] = slots
      .map((s, i) => ({
        slot: i + 1,
        analysis_service_id: parseInt(s.analysis_service_id, 10),
      }))
      .filter(a => !isNaN(a.analysis_service_id))

    setSaving(true)
    setError(null)
    try {
      await createPeptide({
        name: name.trim(),
        abbreviation: abbreviation.trim().toUpperCase(),
        analytes,
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create peptide')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose() }}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Add New Peptide</SheetTitle>
          <SheetDescription>
            Define a peptide and link up to 4 analyte services.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5 px-4">
          {/* Basic fields */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="peptide-name">Full Name</Label>
              <Input
                id="peptide-name"
                placeholder="e.g., Lysine-Proline-Valine"
                value={name}
                onChange={e => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="peptide-abbr">Abbreviation</Label>
              <Input
                id="peptide-abbr"
                placeholder="e.g., KPV"
                value={abbreviation}
                onChange={e => setAbbreviation(e.target.value)}
                required
              />
            </div>
          </div>

          {/* Analyte Slots */}
          <div className="space-y-3">
            <Label className="text-sm font-semibold">Analytes</Label>
            <p className="text-xs text-muted-foreground">
              Link up to 4 analysis services (Peptide Identity).
            </p>
            {loadingServices ? (
              <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading analysis services...
              </div>
            ) : (
              <div className="space-y-3">
                {slots.map((slot, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <span className="flex items-center justify-center h-9 w-7 shrink-0 rounded bg-zinc-800 text-xs font-mono text-zinc-400">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <Select
                        value={slot.analysis_service_id}
                        onValueChange={v => updateSlot(i, { analysis_service_id: v })}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select analysis service..." />
                        </SelectTrigger>
                        <SelectContent>
                          {services.map(svc => (
                            <SelectItem key={svc.id} value={String(svc.id)}>
                              {svc.peptide_name || svc.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <SheetFooter className="px-0">
            <Button type="submit" disabled={saving || !name.trim() || !abbreviation.trim()}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saving ? 'Saving...' : 'Add Peptide'}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
