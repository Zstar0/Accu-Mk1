import { useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { HPLCWeightsInput } from '@/lib/api'

interface WeightsFormProps {
  weights: HPLCWeightsInput
  diluentDensity: number
  onChange: (weights: HPLCWeightsInput) => void
}

export function WeightsForm({
  weights,
  diluentDensity,
  onChange,
}: WeightsFormProps) {
  const update = (field: keyof HPLCWeightsInput, value: string) => {
    onChange({ ...weights, [field]: parseFloat(value) || 0 })
  }

  // Live-calculated derived values
  const derived = useMemo(() => {
    const stockMass = weights.stock_vial_with_diluent - weights.stock_vial_empty
    const stockVolMl = stockMass / 1000

    const diluentMass = weights.dil_vial_with_diluent - weights.dil_vial_empty
    const diluentVolUl = (diluentMass / diluentDensity) * 1000

    const sampleMass =
      weights.dil_vial_with_diluent_and_sample - weights.dil_vial_with_diluent
    const sampleVolUl = (sampleMass / diluentDensity) * 1000

    const totalVolUl = diluentVolUl + sampleVolUl
    const df = sampleVolUl > 0 ? totalVolUl / sampleVolUl : 0

    return { stockVolMl, diluentVolUl, sampleVolUl, df, sampleMass }
  }, [weights, diluentDensity])

  return (
    <div className="flex flex-col gap-4">
      {/* Stock vial */}
      <div>
        <p className="mb-2 text-sm font-medium">Stock Vial</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">Vial + Cap (mg)</Label>
            <Input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={weights.stock_vial_empty || ''}
              onChange={e => update('stock_vial_empty', e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Vial + Cap + Diluent (mg)</Label>
            <Input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={weights.stock_vial_with_diluent || ''}
              onChange={e => update('stock_vial_with_diluent', e.target.value)}
              className="font-mono"
            />
          </div>
        </div>
        {derived.stockVolMl > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            Stock volume:{' '}
            <span className="font-mono font-medium">
              {derived.stockVolMl.toFixed(4)} mL
            </span>
          </p>
        )}
      </div>

      {/* Dilution vial */}
      <div>
        <p className="mb-2 text-sm font-medium">Dilution Vial</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs">Vial + Cap (mg)</Label>
            <Input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={weights.dil_vial_empty || ''}
              onChange={e => update('dil_vial_empty', e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">+ Diluent (mg)</Label>
            <Input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={weights.dil_vial_with_diluent || ''}
              onChange={e => update('dil_vial_with_diluent', e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">+ Diluent + Sample (mg)</Label>
            <Input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={weights.dil_vial_with_diluent_and_sample || ''}
              onChange={e =>
                update('dil_vial_with_diluent_and_sample', e.target.value)
              }
              className="font-mono"
            />
          </div>
        </div>
        {derived.df > 0 && (
          <div className="mt-2 grid grid-cols-3 gap-2 rounded-md bg-muted/50 p-2 text-xs">
            <div>
              <span className="text-muted-foreground">Diluent Vol</span>
              <p className="font-mono font-medium">
                {derived.diluentVolUl.toFixed(2)} µL
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Sample Vol</span>
              <p className="font-mono font-medium">
                {derived.sampleVolUl.toFixed(2)} µL
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Dilution Factor</span>
              <p className="font-mono font-medium text-primary">
                {derived.df.toFixed(4)}×
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
