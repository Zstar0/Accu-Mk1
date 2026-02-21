import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { getPeptides, type PeptideRecord } from '@/lib/api'

interface PeptideSelectorProps {
  value: number | null
  onChange: (peptide: PeptideRecord | null) => void
  /** Peptide folder name from weight extraction — triggers auto-select */
  autoSelectFolder?: string | null
  /** Blend peptide label (e.g. "BPC", "TB500") — triggers auto-select by abbreviation */
  autoSelectLabel?: string | null
}

export function PeptideSelector({ value, onChange, autoSelectFolder, autoSelectLabel }: PeptideSelectorProps) {
  const [peptides, setPeptides] = useState<PeptideRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getPeptides()
      .then(setPeptides)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  // Auto-select peptide: blend label takes priority over folder name
  useEffect(() => {
    if (value != null || peptides.length === 0) return

    // For blends, use the specific peptide label (e.g. "BPC" → BPC-157)
    if (autoSelectLabel) {
      const label = autoSelectLabel.toLowerCase()
      const match =
        peptides.find(p => p.abbreviation.toLowerCase() === label) ??
        peptides.find(p => p.name.toLowerCase() === label) ??
        peptides.find(p => p.abbreviation.toLowerCase().replace(/[-\s]/g, '').includes(label.replace(/[-\s]/g, '')) ||
          label.replace(/[-\s]/g, '').includes(p.abbreviation.toLowerCase().replace(/[-\s]/g, ''))) ??
        peptides.find(p => p.name.toLowerCase().includes(label) || label.includes(p.name.toLowerCase()))
      if (match) onChange(match)
      return  // Don't fall through to folder match for blends
    }

    // For non-blend: match by SharePoint folder name
    if (autoSelectFolder) {
      const folder = autoSelectFolder.toLowerCase()
      const match =
        peptides.find(p => p.name.toLowerCase() === folder) ??
        peptides.find(p => p.abbreviation.toLowerCase() === folder) ??
        peptides.find(p => folder.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(folder)) ??
        peptides.find(p => folder.includes(p.abbreviation.toLowerCase()))
      if (match) onChange(match)
    }
  }, [autoSelectFolder, autoSelectLabel, peptides, value, onChange])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading peptides...
      </div>
    )
  }

  if (peptides.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No peptides configured. Add one in Peptide Config first.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <Label>Peptide</Label>
      <Select
        value={value != null ? String(value) : undefined}
        onValueChange={val => {
          const id = parseInt(val, 10)
          const peptide = peptides.find(p => p.id === id) ?? null
          onChange(peptide)
        }}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select a peptide..." />
        </SelectTrigger>
        <SelectContent>
          {peptides.map(p => (
            <SelectItem key={p.id} value={String(p.id)}>
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.abbreviation}</span>
                <span className="text-xs text-muted-foreground">{p.name}</span>
                {p.active_calibration ? (
                  <Badge variant="default" className="ml-auto text-xs">
                    Cal
                  </Badge>
                ) : (
                  <Badge variant="outline" className="ml-auto text-xs">
                    No Cal
                  </Badge>
                )}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
