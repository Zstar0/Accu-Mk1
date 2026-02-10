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
}

export function PeptideSelector({ value, onChange, autoSelectFolder }: PeptideSelectorProps) {
  const [peptides, setPeptides] = useState<PeptideRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getPeptides()
      .then(setPeptides)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  // Auto-select peptide when folder name is provided
  useEffect(() => {
    if (!autoSelectFolder || value != null || peptides.length === 0) return
    const folder = autoSelectFolder.toLowerCase()
    const match =
      peptides.find(p => p.name.toLowerCase() === folder) ??
      peptides.find(p => p.abbreviation.toLowerCase() === folder) ??
      peptides.find(p => folder.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(folder)) ??
      peptides.find(p => folder.includes(p.abbreviation.toLowerCase()))
    if (match) onChange(match)
  }, [autoSelectFolder, peptides, value, onChange])

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
