import { useState } from 'react'
import { Loader2, Lock, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  updateMethod,
  type EndoRunParamsWire,
  type HplcMethod,
} from '@/lib/api'
import {
  ENDO_RUN_PARAM_DEFAULTS,
  type EndoRunParams,
} from '@/lib/endo-prep-2ml'
import {
  HPLC_RUN_PARAM_DEFAULTS,
  type HplcRunParamsWire,
} from '@/lib/hplc-run-params'

type Block = 'endotoxin' | 'hplc'

interface Field {
  key: string
  label: string
  unit: string
  /** The default, shown as the placeholder. */
  standard: number
}

const ENDO_FIELDS: {
  key: keyof EndoRunParamsWire
  label: string
  unit: string
  standard: keyof EndoRunParams
}[] = [
  {
    key: 'std_total_dilution',
    label: 'Standard total dilution',
    unit: '1:N',
    standard: 'stdTotalDilution',
  },
  {
    key: 'recon_water_ml',
    label: 'Reconstitution water',
    unit: 'mL',
    standard: 'reconWaterMl',
  },
  {
    key: 'spike_recovery_min_pct',
    label: 'Spike recovery min',
    unit: '%',
    standard: 'spikeRecoveryMinPct',
  },
  {
    key: 'spike_recovery_max_pct',
    label: 'Spike recovery max',
    unit: '%',
    standard: 'spikeRecoveryMaxPct',
  },
  {
    key: 'cv_limit_pct',
    label: 'CV limit',
    unit: '%',
    standard: 'cvLimitPct',
  },
]

const HPLC_FIELDS: [keyof HplcRunParamsWire, string, string][] = [
  ['default_target_ug_ml', 'Default target', 'ug/mL'],
  ['intermediate_target_ug_ml', 'Intermediate target', 'ug/mL'],
  ['intermediate_volume_ul', 'Intermediate volume', 'uL'],
  ['two_step_threshold_mg', 'Two-step from', 'mg'],
  ['bac_stock_ug_ml', 'Bac water stock', 'ug/mL'],
  ['bac_target_ug_ml', 'Bac water target', 'ug/mL'],
  ['capsule_neat_max_ug_ml', 'Capsule neat limit', 'ug/mL'],
  ['diluent_density_mg_ml', 'Diluent density', 'mg/mL'],
  ['benzyl_alcohol_density_mg_ml', 'Benzyl alcohol density', 'mg/mL'],
  ['floor_ug_ml', 'Blend floor', 'ug/mL'],
  ['target_volume_ul', 'Target volume', 'uL'],
  ['sample_diluent_ul', 'Diluent to add', 'uL'],
  ['volume_tolerance_pct', 'Volume tolerance', '%'],
]

const BLOCKS: Record<
  Block,
  { title: string; fields: Field[]; blankAsNull: boolean }
> = {
  endotoxin: {
    title: 'endotoxin',
    fields: ENDO_FIELDS.map(f => ({
      ...f,
      standard: ENDO_RUN_PARAM_DEFAULTS[f.standard],
    })),
    // A blank endotoxin field is left out, as it always has been.
    blankAsNull: false,
  },
  hplc: {
    title: 'HPLC',
    fields: HPLC_FIELDS.map(([key, label, unit]) => ({
      key,
      label,
      unit,
      standard: HPLC_RUN_PARAM_DEFAULTS[key],
    })),
    // A blank HPLC field is sent as null, which the server reads as "use the
    // default" and drops.
    blankAsNull: true,
  },
}

/**
 * The endotoxin run parameters a method fixes (spec 2026-10-10 3.4, 6.5):
 * the standard total dilution, the reconstitution water, the spike recovery
 * range and the CV limit. A blank field uses Dennis's value, shown as its
 * placeholder. Draft only: worksheets pin a method revision, so an issued
 * method's numbers never move under a run, and the server 409s on
 * run_parameters merely being sent for a locked method, so nothing here
 * sends it unless the method is a draft. The server validates the rest
 * (min below max, total at least 20) and its reason is shown as it comes.
 *
 * With block="hplc" the same section edits the HPLC prep worksheet's
 * thirteen method constants (run_parameters.hplc). The server replaces
 * run_parameters whole, so every save carries the other block on the method.
 */
export function MethodRunParamsSection({
  method,
  onUpdated,
  block = 'endotoxin',
}: {
  method: HplcMethod
  onUpdated: () => void
  block?: Block
}) {
  const { title, fields, blankAsNull } = BLOCKS[block]
  const locked = method.status !== 'draft'
  const saved: Partial<Record<string, number | null>> =
    method.run_parameters?.[block] ?? {}
  const savedText = (key: string) => {
    const v = saved[key]
    return v == null ? '' : String(v)
  }
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map(f => [f.key, savedText(f.key)]))
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = fields.some(
    f => (draft[f.key] ?? '').trim() !== savedText(f.key)
  )

  async function handleSave() {
    if (locked) return
    const values: Record<string, number | null> = {}
    for (const f of fields) {
      const text = (draft[f.key] ?? '').trim()
      if (!text) {
        if (blankAsNull) values[f.key] = null
        continue
      }
      const n = Number(text)
      if (!Number.isFinite(n) || n <= 0) {
        setError(`${f.label} must be a number above zero`)
        return
      }
      values[f.key] = n
    }
    // Keep the other block already on the method; replace only this one.
    const runParameters: Record<string, unknown> = Object.fromEntries(
      Object.entries(method.run_parameters ?? {}).filter(([k]) => k !== block)
    )
    if (Object.keys(values).length) runParameters[block] = values
    setSaving(true)
    setError(null)
    try {
      await updateMethod(method.id, {
        run_parameters: Object.keys(runParameters).length
          ? runParameters
          : null,
      })
      onUpdated()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to save run parameters'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-t pt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-muted-foreground">
          Run parameters ({title})
        </h4>
        {locked ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" />
            Changes need a new revision
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={handleSave}
            disabled={saving || !dirty}
          >
            {saving ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1 h-3.5 w-3.5" />
            )}
            Save run parameters
          </Button>
        )}
      </div>
      {error && (
        <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {fields.map(f => (
          <div key={f.key} className="space-y-1 text-sm">
            <div className="font-medium text-muted-foreground">
              {f.label} <span className="font-normal">({f.unit})</span>
            </div>
            <Input
              inputMode="decimal"
              aria-label={`${f.label} (${f.unit})`}
              placeholder={String(f.standard)}
              value={draft[f.key] ?? ''}
              disabled={locked}
              className="h-8 font-mono"
              onChange={e => setDraft({ ...draft, [f.key]: e.target.value })}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

export default MethodRunParamsSection
