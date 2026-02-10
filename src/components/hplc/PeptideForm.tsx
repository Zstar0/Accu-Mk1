import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createPeptide } from '@/lib/api'

interface PeptideFormProps {
  onSaved: () => void
  onCancel: () => void
}

export function PeptideForm({ onSaved, onCancel }: PeptideFormProps) {
  const [name, setName] = useState('')
  const [abbreviation, setAbbreviation] = useState('')
  const [referenceRt, setReferenceRt] = useState('')
  const [rtTolerance, setRtTolerance] = useState('0.5')
  const [diluentDensity, setDiluentDensity] = useState('997.1')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !abbreviation.trim()) return

    setSaving(true)
    setError(null)
    try {
      await createPeptide({
        name: name.trim(),
        abbreviation: abbreviation.trim().toUpperCase(),
        reference_rt: referenceRt ? parseFloat(referenceRt) : null,
        rt_tolerance: parseFloat(rtTolerance) || 0.5,
        diluent_density: parseFloat(diluentDensity) || 997.1,
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create peptide')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add New Peptide</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="peptide-rt">Reference RT (min)</Label>
              <Input
                id="peptide-rt"
                type="number"
                step="0.001"
                placeholder="e.g., 4.167"
                value={referenceRt}
                onChange={e => setReferenceRt(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="peptide-tol">RT Tolerance (min)</Label>
              <Input
                id="peptide-tol"
                type="number"
                step="0.01"
                value={rtTolerance}
                onChange={e => setRtTolerance(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="peptide-density">Diluent Density (mg/mL)</Label>
              <Input
                id="peptide-density"
                type="number"
                step="0.1"
                value={diluentDensity}
                onChange={e => setDiluentDensity(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saving ? 'Saving...' : 'Add Peptide'}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
