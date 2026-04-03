import { useState, useEffect, useRef } from 'react'
import { Loader2, Search } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import {
  getPeptides,
  getInstruments,
  createWizardSession,
  updateWizardSession,
  getSenaiteStatus,
  lookupSenaiteSample,
  type PeptideRecord,
  type SenaiteLookupResult,
  type VialParams,
  type WizardSessionResponse,
  type Instrument,
} from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { useWizardStore } from '@/store/wizard-store'
import { useUIStore } from '@/store/ui-store'

interface AnalyteParamLocal {
  declaredWeight: string
  targetConc: string
  targetVol: string
}

// Per-vial → per-analyte state: { "1": { "BPC-157": { declaredWeight, targetConc, targetVol } } }
type VialAnalyteStateMap = Record<string, Record<string, AnalyteParamLocal>>

export function Step1SampleInfo() {
  const session = useWizardStore(state => state.session)

  // Form state (local — transient until submit)
  const [peptides, setPeptides] = useState<PeptideRecord[]>([])
  const [loadingPeptides, setLoadingPeptides] = useState(true)
  const [peptideError, setPeptideError] = useState<string | null>(null)

  const [peptideId, setPeptideId] = useState<number | null>(null)
  const [sampleIdLabel, setSampleIdLabel] = useState('')
  const [declaredWeightMg, setDeclaredWeightMg] = useState('')
  const [targetConcUgMl, setTargetConcUgMl] = useState('')
  const [targetTotalVolUl, setTargetTotalVolUl] = useState('')

  // Standard prep metadata
  const [isStandard, setIsStandard] = useState(false)
  const [manufacturer, setManufacturer] = useState('')
  const [standardNotes, setStandardNotes] = useState('')
  const [instrumentId, setInstrumentId] = useState<string>('')
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [standardConcentrations, setLocalConcentrations] = useState<string[]>(
    ['1000', '500', '250', '100', '10', '1']
  )

  // Multi-vial state: per-vial → per-analyte declared weight, target conc, target vol
  const [vialAnalyteState, setVialAnalyteState] = useState<VialAnalyteStateMap>({})

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Tracks whether a prefill just applied — prevents tab switch from clearing peptide
  const prefillAppliedRef = useRef(false)

  // SENAITE state
  const [senaiteEnabled, setSenaiteEnabled] = useState(false)
  const [checkingStatus, setCheckingStatus] = useState(true)
  const [activeTab, setActiveTab] = useState<'lookup' | 'manual'>('manual')

  // Lookup state
  const setSenaiteResult = useWizardStore(state => state.setSenaiteResult)
  const [lookupId, setLookupId] = useState('')
  const [lookupLoading, setLookupLoading] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lookupResult, setLookupResult] = useState<SenaiteLookupResult | null>(null)

  // Load peptides and check SENAITE status on mount
  useEffect(() => {
    let cancelled = false

    async function loadPeptides() {
      try {
        setLoadingPeptides(true)
        const data = await getPeptides()
        if (!cancelled) {
          setPeptides(data)
          setPeptideError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setPeptideError(
            err instanceof Error ? err.message : 'Failed to load peptides'
          )
        }
      } finally {
        if (!cancelled) setLoadingPeptides(false)
      }
    }

    async function checkSenaiteStatus() {
      try {
        const status = await getSenaiteStatus()
        if (!cancelled) {
          if (status.enabled) {
            setSenaiteEnabled(true)
            setActiveTab('lookup')
          } else {
            setSenaiteEnabled(false)
            setActiveTab('manual')
          }
        }
      } catch {
        if (!cancelled) {
          setSenaiteEnabled(false)
          setActiveTab('manual')
        }
      } finally {
        if (!cancelled) setCheckingStatus(false)
      }
    }

    loadPeptides()
    checkSenaiteStatus()
    getInstruments().then(data => { if (!cancelled) setInstruments(data) }).catch(_e => { /* non-critical */ })

    return () => {
      cancelled = true
    }
  }, [])

  // Apply worksheet pre-fill if present (from Start Prep in worksheet drawer)
  // Runs once when peptides finish loading — reads prefill from store, applies, clears
  useEffect(() => {
    if (loadingPeptides || peptides.length === 0) return
    const prefill = useUIStore.getState().worksheetPrepPrefill
    if (!prefill) return
    // Set sample ID for both SENAITE lookup and manual entry
    if (prefill.sampleId) {
      setSampleIdLabel(prefill.sampleId)
      setLookupId(prefill.sampleId)
      // Switch to lookup tab if SENAITE is available (checked at read time, not dep)
      if (senaiteEnabled) {
        setActiveTab('lookup')
      }
    }
    // Set peptide
    if (prefill.peptideId) {
      const match = peptides.find(p => p.id === prefill.peptideId)
      if (match) {
        setPeptideId(match.id)
      }
    }
    // Set instrument
    if (prefill.instrumentId) {
      setInstrumentId(String(prefill.instrumentId))
    }
    // Mark prefill as applied so tab switch doesn't clear peptide
    prefillAppliedRef.current = true
    // Clear prefill so it doesn't re-apply
    useUIStore.getState().clearWorksheetPrepPrefill()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingPeptides, peptides])

  // Multi-vial / multi-analyte helpers (must be before early return)
  const isMultiVial = (peptides.find(p => p.id === peptideId)?.prep_vial_count ?? 1) > 1
  const vialCount = peptides.find(p => p.id === peptideId)?.prep_vial_count ?? 1
  const selectedPeptideForVials = peptideId !== null ? peptides.find(p => p.id === peptideId) : null
  // Show per-analyte inputs for any blend with 2+ components (even single-vial blends)
  const isMultiAnalyte = isMultiVial || (selectedPeptideForVials?.is_blend === true && (selectedPeptideForVials?.components.length ?? 0) > 1)

  function getAnalyteParam(vial: number, analyte: string, field: 'declaredWeight' | 'targetConc' | 'targetVol'): string {
    return vialAnalyteState[String(vial)]?.[analyte]?.[field] ?? ''
  }
  function setAnalyteParam(vial: number, analyte: string, field: 'declaredWeight' | 'targetConc' | 'targetVol', value: string) {
    setVialAnalyteState(prev => {
      const vKey = String(vial)
      const vialAnalytes = prev[vKey] ?? {}
      const current = vialAnalytes[analyte] ?? { declaredWeight: '', targetConc: '', targetVol: '' }
      return {
        ...prev,
        [vKey]: {
          ...vialAnalytes,
          [analyte]: { ...current, [field]: value },
        },
      }
    })
  }

  // Initialize per-analyte state when peptide is a blend
  useEffect(() => {
    if (!isMultiAnalyte || !selectedPeptideForVials) return
    setVialAnalyteState(prev => {
      const next = { ...prev }
      for (let v = 1; v <= vialCount; v++) {
        const vKey = String(v)
        if (!next[vKey]) next[vKey] = {}
        const compsInVial = selectedPeptideForVials.components.filter(c => (c.vial_number ?? 1) === v)
        for (const comp of compsInVial) {
          if (!next[vKey][comp.abbreviation]) {
            next[vKey][comp.abbreviation] = { declaredWeight: '', targetConc: '', targetVol: '' }
          }
        }
      }
      return next
    })
  }, [isMultiAnalyte, vialCount, peptideId, selectedPeptideForVials])

  // Auto-populate per-analyte declared weights from SENAITE analyte declared_quantity
  useEffect(() => {
    if (!isMultiAnalyte || !selectedPeptideForVials || !lookupResult) return
    const newState: VialAnalyteStateMap = {}
    for (let v = 1; v <= vialCount; v++) {
      const vKey = String(v)
      newState[vKey] = {}
      const compsInVial = selectedPeptideForVials.components.filter(c => (c.vial_number ?? 1) === v)
      for (const comp of compsInVial) {
        const analyte = lookupResult.analytes.find(a => a.matched_peptide_id === comp.id)
        newState[vKey][comp.abbreviation] = {
          declaredWeight: analyte?.declared_quantity != null ? String(analyte.declared_quantity) : '',
          targetConc: '',
          targetVol: '',
        }
      }
    }
    setVialAnalyteState(newState)
  }, [lookupResult, isMultiAnalyte, vialCount, peptideId, selectedPeptideForVials])

  // If session already exists — show read-only summary with editable target fields
  // Also ensure selectedPeptide is set in the store so the info panel shows methods
  const sessionPeptide = session !== null ? peptides.find(p => p.id === session.peptide_id) : undefined
  useEffect(() => {
    if (!sessionPeptide) return
    const current = useWizardStore.getState().selectedPeptide
    if (current?.id !== sessionPeptide.id) {
      useWizardStore.getState().setSelectedPeptide(sessionPeptide)
    }
  }, [sessionPeptide])

  if (session !== null) {
    return (
      <EditableSessionSummary
        session={session}
        peptide={sessionPeptide}
      />
    )
  }

  // For blends: all analytes must have target conc + vol filled
  const multiVialReady = isMultiAnalyte
    ? Array.from({ length: vialCount }, (_, i) => i + 1).every(v => {
        const vialAnalytes = vialAnalyteState[String(v)]
        if (!vialAnalytes) return false
        return Object.values(vialAnalytes).every(
          ap => ap.targetConc.trim() !== '' && ap.targetVol.trim() !== ''
        )
      })
    : true

  // Standards use concentration levels instead of target conc/vol fields
  const standardReady = isStandard
    ? standardConcentrations.filter(s => { const n = parseFloat(s); return !isNaN(n) && n > 0 }).length >= 3
    : true

  const canSubmit =
    peptideId !== null &&
    instrumentId !== '' &&
    (isStandard
      ? standardReady
      : (isMultiAnalyte ? multiVialReady : (targetConcUgMl.trim() !== '' && targetTotalVolUl.trim() !== ''))) &&
    !submitting

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || peptideId === null) return

    setSubmitting(true)
    setSubmitError(null)

    try {
      const data: Parameters<typeof createWizardSession>[0] = {
        peptide_id: peptideId,
      }
      if (sampleIdLabel.trim()) data.sample_id_label = sampleIdLabel.trim()
      if (instrumentId) data.instrument_id = Number(instrumentId)

      // Standard prep metadata
      if (isStandard) {
        data.is_standard = true
        if (manufacturer.trim()) data.manufacturer = manufacturer.trim()
        if (standardNotes.trim()) data.standard_notes = standardNotes.trim()

        // Build standard vial_params from concentration levels
        const validConcs = standardConcentrations
          .map(s => parseFloat(s))
          .filter(n => !isNaN(n) && n > 0)

        if (validConcs.length < 3) {
          setSubmitError('At least 3 valid concentration levels are required for standards.')
          setSubmitting(false)
          return
        }

        const stdVialParams: Record<string, VialParams> = {}
        validConcs.forEach((conc, i) => {
          stdVialParams[String(i + 1)] = {
            declared_weight_mg: null,
            target_conc_ug_ml: conc,
            target_total_vol_ul: 1500, // Default total volume
          }
        })
        data.vial_params = stdVialParams
      }

      if (!isStandard && isMultiAnalyte) {
        // Blend: build per-analyte params within each vial
        const vialParams: Record<string, {
          declared_weight_mg: number | null
          target_conc_ug_ml: number | null
          target_total_vol_ul: number | null
          analyte_params: Record<string, { declared_weight_mg: number | null; target_conc_ug_ml: number | null; target_total_vol_ul: number | null }>
        }> = {}
        for (let v = 1; v <= vialCount; v++) {
          const vKey = String(v)
          const vialAnalytes = vialAnalyteState[vKey] ?? {}
          const analyteParams: Record<string, { declared_weight_mg: number | null; target_conc_ug_ml: number | null; target_total_vol_ul: number | null }> = {}
          let totalDeclared = 0
          let firstConc: number | null = null
          let firstVol: number | null = null
          for (const [aKey, ap] of Object.entries(vialAnalytes)) {
            const dw = parseFloat(ap.declaredWeight)
            const tc = parseFloat(ap.targetConc)
            const tv = parseFloat(ap.targetVol)
            analyteParams[aKey] = {
              declared_weight_mg: isNaN(dw) ? null : dw,
              target_conc_ug_ml: isNaN(tc) ? null : tc,
              target_total_vol_ul: isNaN(tv) ? null : tv,
            }
            if (!isNaN(dw)) totalDeclared += dw
            if (firstConc === null && !isNaN(tc)) firstConc = tc
            if (firstVol === null && !isNaN(tv)) firstVol = tv
          }
          vialParams[vKey] = {
            // Backward compat: sum declared weights, use first analyte's target
            declared_weight_mg: totalDeclared > 0 ? totalDeclared : null,
            target_conc_ug_ml: firstConc,
            target_total_vol_ul: firstVol,
            analyte_params: analyteParams,
          }
        }
        data.vial_params = vialParams
        // Flat fields from vial 1 for backward compat
        const v1 = vialParams['1']
        if (v1) {
          if (v1.declared_weight_mg != null) data.declared_weight_mg = v1.declared_weight_mg
          if (v1.target_conc_ug_ml != null) data.target_conc_ug_ml = v1.target_conc_ug_ml
          if (v1.target_total_vol_ul != null) data.target_total_vol_ul = v1.target_total_vol_ul
        }
      } else {
        // Single vial: existing behavior
        if (declaredWeightMg.trim()) {
          const parsed = parseFloat(declaredWeightMg)
          if (!isNaN(parsed)) data.declared_weight_mg = parsed
        }
        const concParsed = parseFloat(targetConcUgMl)
        if (!isNaN(concParsed)) data.target_conc_ug_ml = concParsed
        const volParsed = parseFloat(targetTotalVolUl)
        if (!isNaN(volParsed)) data.target_total_vol_ul = volParsed
      }

      const response = await createWizardSession(data)
      const selectedPeptideComponents = selectedPeptide?.components ?? []
      useWizardStore.getState().startSession(response, selectedPeptideComponents, selectedPeptide ?? undefined)
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Failed to create session'
      )
    } finally {
      setSubmitting(false)
    }
  }

  function handleTabChange(tab: string) {
    // If a worksheet prefill just applied, don't clear on first tab switch
    if (prefillAppliedRef.current) {
      prefillAppliedRef.current = false
      setActiveTab(tab as 'lookup' | 'manual')
      return
    }
    if (tab === 'manual') {
      // Per user decision: clear everything when switching to manual
      setPeptideId(null)
      setSampleIdLabel('')
      setDeclaredWeightMg('')
      setLookupResult(null)
      setLookupError(null)
    }
    if (tab === 'lookup') {
      // Clear manual-entered values when switching back to lookup
      setPeptideId(null)
      setSampleIdLabel('')
      setDeclaredWeightMg('')
    }
    setActiveTab(tab as 'lookup' | 'manual')
  }

  async function handleLookup() {
    if (!lookupId.trim()) return
    setLookupLoading(true)
    setLookupError(null)
    setLookupResult(null)
    try {
      const result = await lookupSenaiteSample(lookupId.trim())
      setLookupResult(result)
      setSenaiteResult(result)  // persist to store so other steps can show it
      // Auto-populate fields from SENAITE data
      setSampleIdLabel(result.sample_id)
      if (result.declared_weight_mg != null) {
        setDeclaredWeightMg(String(result.declared_weight_mg))
      }
      // Auto-select peptide: try blend match first, then single peptide
      const matchedIds = result.analytes
        .filter(a => a.matched_peptide_id !== null)
        .map(a => a.matched_peptide_id as number)

      if (matchedIds.length > 1) {
        // Multiple analytes matched — look for a blend whose components match exactly
        const matchedSet = new Set(matchedIds)
        const blendMatch = peptides.find(p =>
          p.is_blend &&
          p.components.length === matchedSet.size &&
          p.components.every(c => matchedSet.has(c.id))
        )
        if (blendMatch) {
          setPeptideId(blendMatch.id)
        }
        // If no blend match, leave dropdown empty for manual selection
      } else if (matchedIds.length === 1) {
        // Single analyte — select it directly (could be a standalone peptide)
        setPeptideId(matchedIds[0] as number)
      }
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Lookup failed')
    } finally {
      setLookupLoading(false)
    }
  }

  // Resolve selected peptide for blend detection
  const selectedPeptide = peptideId !== null ? peptides.find(p => p.id === peptideId) : null

  // Filter blends out when Standard is checked (standards are single-peptide only)
  const filteredPeptides = isStandard ? peptides.filter(p => !p.is_blend) : peptides

  // Shared peptide dropdown (used in both tabs)
  const peptideDropdown = (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor="peptide-select">
          Peptide <span className="text-destructive">*</span>
        </Label>
        {loadingPeptides ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading peptides...
          </div>
        ) : (
          <Select
            value={peptideId !== null ? String(peptideId) : ''}
            onValueChange={val => setPeptideId(Number(val))}
          >
            <SelectTrigger id="peptide-select">
              <SelectValue placeholder="Select peptide..." />
            </SelectTrigger>
            <SelectContent>
              {filteredPeptides.map(p => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name} ({p.abbreviation})
                  {p.is_blend ? ' · Blend' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {selectedPeptide?.is_blend && selectedPeptide.components.length > 0 && (
        <div className="rounded-md border border-blue-500/20 bg-blue-50/50 dark:bg-blue-950/15 p-3 space-y-2">
          <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
            Blend — {selectedPeptide.components.length} component peptides
          </p>
          <div className="flex flex-wrap gap-1.5">
            {selectedPeptide.components.map(c => (
              <Badge key={c.id} variant="secondary" className="text-xs">
                {c.abbreviation}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  // Standard sample toggle + conditional metadata fields
  const standardFields = (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Switch
          id="is-standard"
          checked={isStandard}
          onCheckedChange={checked => {
            setIsStandard(checked)
            if (!checked) {
              setManufacturer('')
              setStandardNotes('')
            }
            if (checked && selectedPeptide?.is_blend) {
              setPeptideId(null)
            }
          }}
        />
        <Label htmlFor="is-standard" className="text-sm font-medium">
          Standard Sample
        </Label>
      </div>
      {/* Instrument selector — always visible */}
      <div className="space-y-1.5">
        <Label htmlFor="instrument-name">Instrument</Label>
        <Select value={instrumentId} onValueChange={setInstrumentId}>
          <SelectTrigger id="instrument-name">
            <SelectValue placeholder="Select instrument…" />
          </SelectTrigger>
          <SelectContent>
            {instruments.map(inst => (
              <SelectItem key={inst.id} value={String(inst.id)}>
                {inst.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isStandard && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="manufacturer">Manufacturer</Label>
            <Input
              id="manufacturer"
              type="text"
              placeholder="e.g. Cayman Chemical"
              value={manufacturer}
              onChange={e => setManufacturer(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="standard-notes">Standard Notes</Label>
            <Input
              id="standard-notes"
              type="text"
              placeholder="Lot number, batch info, etc."
              value={standardNotes}
              onChange={e => setStandardNotes(e.target.value)}
            />
          </div>

          {/* Concentration levels editor */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Concentration Levels (ug/mL)</Label>
            <div className="flex flex-wrap gap-2">
              {[...standardConcentrations]
                .map((val, idx) => ({ val, idx }))
                .sort((a, b) => {
                  const na = parseFloat(a.val) || 0
                  const nb = parseFloat(b.val) || 0
                  return nb - na
                })
                .map(({ val, idx }) => (
                  <div key={idx} className="flex items-center gap-1">
                    <Input
                      type="number"
                      step="0.1"
                      className="w-24 h-8 text-sm"
                      value={val}
                      onChange={e => {
                        setLocalConcentrations(prev => {
                          const next = [...prev]
                          next[idx] = e.target.value
                          return next
                        })
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                      disabled={standardConcentrations.length <= 3}
                      onClick={() => {
                        setLocalConcentrations(prev => prev.filter((_, i) => i !== idx))
                      }}
                    >
                      X
                    </Button>
                  </div>
                ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setLocalConcentrations(prev => [...prev, ''])}
            >
              Add Level
            </Button>
          </div>
        </div>
      )}
    </div>
  )

  // Shared target fields (appear below lookup summary card or in manual form)
  const targetFields = (
    <>
      {/* Target Concentration */}
      <div className="space-y-1.5">
        <Label htmlFor="target-conc">
          Target Concentration (µg/mL){' '}
          <span className="text-destructive">*</span>
        </Label>
        <Input
          id="target-conc"
          type="number"
          step="0.1"
          placeholder="e.g. 1200"
          value={targetConcUgMl}
          onChange={e => setTargetConcUgMl(e.target.value)}
        />
      </div>

      {/* Target Total Volume */}
      <div className="space-y-1.5">
        <Label htmlFor="target-vol">
          Target Total Volume (µL){' '}
          <span className="text-destructive">*</span>
        </Label>
        <Input
          id="target-vol"
          type="number"
          step="0.1"
          placeholder="e.g. 1200"
          value={targetTotalVolUl}
          onChange={e => setTargetTotalVolUl(e.target.value)}
        />
      </div>
    </>
  )

  // Per-analyte fields for blends (single-vial or multi-vial)
  const perVialFields = isMultiAnalyte && selectedPeptide ? (
    <div className="space-y-4">
      {Array.from({ length: vialCount }, (_, i) => i + 1).map(v => {
        const compsInVial = selectedPeptide.components.filter(c => (c.vial_number ?? 1) === v)
        const label = compsInVial.map(c => c.abbreviation).join(', ') || `Vial ${v}`
        return (
          <div key={v} className="rounded-md border border-zinc-700 p-3 space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">Vial {v}</Badge>
              <span className="text-xs text-muted-foreground">{label}</span>
            </div>
            {compsInVial.map(comp => (
              <div key={comp.id} className="rounded border border-zinc-600/50 p-2.5 space-y-2">
                <p className="text-xs font-medium text-muted-foreground">{comp.abbreviation}</p>
                <div className="space-y-1.5">
                  <Label htmlFor={`v${v}-${comp.abbreviation}-weight`}>Declared Qty (mg)</Label>
                  <Input
                    id={`v${v}-${comp.abbreviation}-weight`}
                    type="number"
                    step="0.01"
                    placeholder="e.g. 10.00"
                    value={getAnalyteParam(v, comp.abbreviation, 'declaredWeight')}
                    onChange={e => setAnalyteParam(v, comp.abbreviation, 'declaredWeight', e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`v${v}-${comp.abbreviation}-conc`}>
                    Target Concentration (µg/mL) <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id={`v${v}-${comp.abbreviation}-conc`}
                    type="number"
                    step="0.1"
                    placeholder="e.g. 1200"
                    value={getAnalyteParam(v, comp.abbreviation, 'targetConc')}
                    onChange={e => setAnalyteParam(v, comp.abbreviation, 'targetConc', e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`v${v}-${comp.abbreviation}-vol`}>
                    Target Total Volume (µL) <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id={`v${v}-${comp.abbreviation}-vol`}
                    type="number"
                    step="0.1"
                    placeholder="e.g. 1200"
                    value={getAnalyteParam(v, comp.abbreviation, 'targetVol')}
                    onChange={e => setAnalyteParam(v, comp.abbreviation, 'targetVol', e.target.value)}
                  />
                </div>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  ) : null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Peptide Vial Weight</CardTitle>
      </CardHeader>
      <CardContent>
        {peptideError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{peptideError}</AlertDescription>
          </Alert>
        )}
        {submitError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}

        {checkingStatus ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking configuration...
          </div>
        ) : senaiteEnabled ? (
          // Two-tab layout when SENAITE is enabled
          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList className="mb-4">
              <TabsTrigger value="lookup">SENAITE Lookup</TabsTrigger>
              <TabsTrigger value="manual">Manual Entry</TabsTrigger>
            </TabsList>

            {/* SENAITE Lookup Tab */}
            <TabsContent value="lookup">
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Standard sample toggle — always visible at top */}
                {standardFields}

                {/* Search field */}
                <div className="space-y-1.5">
                  <Label htmlFor="senaite-id">SENAITE Sample ID</Label>
                  <div className="flex gap-2">
                    <Input
                      id="senaite-id"
                      type="text"
                      placeholder="e.g. S-0001"
                      value={lookupId}
                      onChange={e => setLookupId(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void handleLookup()
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void handleLookup()}
                      disabled={lookupLoading || !lookupId.trim()}
                    >
                      {lookupLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Search className="h-4 w-4" />
                      )}
                      <span className="ml-1">Look Up</span>
                    </Button>
                  </div>
                </div>

                {/* Lookup error */}
                {lookupError && (
                  <Alert variant="destructive">
                    <AlertDescription>{lookupError}</AlertDescription>
                  </Alert>
                )}

                {/* SENAITE result summary card */}
                {lookupResult && (
                  <div className="rounded-md border border-blue-500/30 bg-blue-50/50 dark:bg-blue-950/20 p-4 space-y-3">
                    <p className="text-sm font-medium text-blue-700 dark:text-blue-300">
                      Sample found in SENAITE
                    </p>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-muted-foreground">Sample ID</span>
                        <p className="font-medium">{lookupResult.sample_id}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Declared Weight</span>
                        <p className="font-medium">
                          {lookupResult.declared_weight_mg != null
                            ? `${lookupResult.declared_weight_mg} mg`
                            : '—'}
                        </p>
                      </div>
                    </div>
                    {lookupResult.analytes.length > 0 && (
                      <div>
                        <span className="text-sm text-muted-foreground">Analytes</span>
                        <ul className="mt-1 space-y-0.5">
                          {lookupResult.analytes.map((a, i) => (
                            <li key={i} className="text-sm flex items-center gap-2">
                              <span
                                className={
                                  a.matched_peptide_id !== null
                                    ? 'text-green-600 dark:text-green-400'
                                    : 'text-muted-foreground'
                                }
                              >
                                {a.matched_peptide_id !== null ? '✓' : '○'}
                              </span>
                              <span>{a.raw_name}</span>
                              {a.matched_peptide_name && (
                                <span className="text-muted-foreground text-xs">
                                  → {a.matched_peptide_name}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {/* Peptide override dropdown (shown after lookup) */}
                {lookupResult && peptideDropdown}

                {/* Declared Weight + Target fields — hidden for standards (uses concentration levels) */}
                {lookupResult && !isStandard && isMultiAnalyte ? (
                  perVialFields
                ) : lookupResult && !isStandard ? (
                  <>
                    {/* Declared Weight — editable override of SENAITE value */}
                    <div className="space-y-1.5">
                      <Label htmlFor="declared-weight-override">
                        Declared Weight (mg)
                      </Label>
                      <Input
                        id="declared-weight-override"
                        type="number"
                        step="0.01"
                        placeholder="e.g. 10.00"
                        value={declaredWeightMg}
                        onChange={e => setDeclaredWeightMg(e.target.value)}
                      />
                      {lookupResult.declared_weight_mg != null &&
                        declaredWeightMg !== String(lookupResult.declared_weight_mg) && (
                          <p className="text-xs text-amber-600 dark:text-amber-400">
                            SENAITE value: {lookupResult.declared_weight_mg} mg (overridden)
                          </p>
                        )}
                    </div>
                    {targetFields}
                  </>
                ) : null}

                {lookupResult && (
                  <Button type="submit" disabled={!canSubmit} className="w-full">
                    {submitting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Creating session...
                      </>
                    ) : (
                      'Create Session'
                    )}
                  </Button>
                )}
              </form>
            </TabsContent>

            {/* Manual Entry Tab */}
            <TabsContent value="manual">
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Standard sample toggle — first */}
                {standardFields}

                {/* Peptide dropdown */}
                {peptideDropdown}

                {/* Sample ID Label */}
                <div className="space-y-1.5">
                  <Label htmlFor="sample-id-label">Sample ID Label</Label>
                  <Input
                    id="sample-id-label"
                    type="text"
                    placeholder="e.g. LOT-2024-001"
                    value={sampleIdLabel}
                    onChange={e => setSampleIdLabel(e.target.value)}
                  />
                </div>

                {/* Declared Weight + Target fields — hidden for standards (uses concentration levels) */}
                {!isStandard && (isMultiAnalyte ? perVialFields : (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="declared-weight">Sample Vial + cap + peptide (mg)</Label>
                      <Input
                        id="declared-weight"
                        type="number"
                        step="0.01"
                        placeholder="e.g. 10.00"
                        value={declaredWeightMg}
                        onChange={e => setDeclaredWeightMg(e.target.value)}
                      />
                    </div>
                    {targetFields}
                  </>
                ))}

                <Button type="submit" disabled={!canSubmit} className="w-full">
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Creating session...
                    </>
                  ) : (
                    'Create Session'
                  )}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        ) : (
          // Manual entry only when SENAITE is disabled
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Standard sample toggle — first */}
            {standardFields}

            {/* Peptide dropdown */}
            {peptideDropdown}

            {/* Sample ID Label */}
            <div className="space-y-1.5">
              <Label htmlFor="sample-id-label">Sample ID Label</Label>
              <Input
                id="sample-id-label"
                type="text"
                placeholder="e.g. LOT-2024-001"
                value={sampleIdLabel}
                onChange={e => setSampleIdLabel(e.target.value)}
              />
            </div>

            {/* Declared Weight + Target fields — hidden for standards (uses concentration levels) */}
            {!isStandard && (isMultiAnalyte ? perVialFields : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="declared-weight">Sample Vial + cap + peptide (mg)</Label>
                  <Input
                    id="declared-weight"
                    type="number"
                    step="0.01"
                    placeholder="e.g. 10.00"
                    value={declaredWeightMg}
                    onChange={e => setDeclaredWeightMg(e.target.value)}
                  />
                </div>
                {targetFields}
              </>
            ))}

            <Button type="submit" disabled={!canSubmit} className="w-full">
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating session...
                </>
              ) : (
                'Create Session'
              )}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Sub-component: editable summary shown when returning to Step 1
// ---------------------------------------------------------------------------

function EditableSessionSummary({
  session,
  peptide,
}: {
  session: WizardSessionResponse
  peptide: PeptideRecord | undefined
}) {
  const vialParamsMap = session.vial_params ?? {}
  const vialKeys = Object.keys(vialParamsMap).sort()
  const isMultiVial = vialKeys.length > 1
  // Detect single-vial blends with per-analyte params
  const hasAnalyteParams = vialKeys.some(k => !!vialParamsMap[k]?.analyte_params)
  const isMultiAnalyte = isMultiVial || hasAnalyteParams

  // Declared weight — single field for the whole session (all vials share it)
  const initialDeclared =
    session.declared_weight_mg != null
      ? String(session.declared_weight_mg)
      : vialKeys[0] != null
        ? String(vialParamsMap[vialKeys[0]]?.declared_weight_mg ?? '')
        : ''
  const [declared, setDeclared] = useState(initialDeclared)
  const [conc, setConc] = useState(
    session.target_conc_ug_ml != null ? String(session.target_conc_ug_ml) : ''
  )
  const [vol, setVol] = useState(
    session.target_total_vol_ul != null ? String(session.target_total_vol_ul) : ''
  )

  // Multi-vial per-analyte editable state: { vialKey: { analyteKey: { conc, vol } } }
  const [analyteEdits, setAnalyteEdits] = useState<Record<string, Record<string, { conc: string; vol: string }>>>(() => {
    if (!isMultiAnalyte) return {}
    const init: Record<string, Record<string, { conc: string; vol: string }>> = {}
    for (const key of vialKeys) {
      const vp = vialParamsMap[key]
      const ap = vp?.analyte_params
      if (ap) {
        init[key] = {}
        for (const [aKey, aParams] of Object.entries(ap)) {
          init[key][aKey] = {
            conc: aParams.target_conc_ug_ml != null ? String(aParams.target_conc_ug_ml) : '',
            vol: aParams.target_total_vol_ul != null ? String(aParams.target_total_vol_ul) : '',
          }
        }
      } else {
        // Legacy per-vial fallback
        init[key] = { _vial: {
          conc: vp?.target_conc_ug_ml != null ? String(vp.target_conc_ug_ml) : '',
          vol: vp?.target_total_vol_ul != null ? String(vp.target_total_vol_ul) : '',
        }}
      }
    }
    return init
  })

  // Session metadata
  const [editInstrumentId, setEditInstrumentId] = useState(
    session.instrument_id != null ? String(session.instrument_id) : ''
  )
  const [editManufacturer, setEditManufacturer] = useState(session.manufacturer ?? '')
  const [editStandardNotes, setEditStandardNotes] = useState(session.standard_notes ?? '')
  const [instruments, setInstruments] = useState<Instrument[]>([])
  useEffect(() => {
    getInstruments().then(setInstruments).catch(_e => { /* non-critical */ })
  }, [])

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function saveMetaField(field: 'instrument_name' | 'manufacturer' | 'standard_notes', value: string) {
    try {
      const updated = await updateWizardSession(session.id, { [field]: value || undefined })
      useWizardStore.getState().updateSession(updated)
    } catch {
      // silent — non-critical meta field
    }
  }

  async function saveInstrumentId(idStr: string) {
    try {
      const id = idStr ? Number(idStr) : undefined
      const updated = await updateWizardSession(session.id, { instrument_id: id })
      useWizardStore.getState().updateSession(updated)
    } catch {
      // silent — non-critical meta field
    }
  }

  const isDirty = isMultiAnalyte
    ? declared !== initialDeclared ||
      vialKeys.some(key => {
        const vp = vialParamsMap[key]
        const vialEdits = analyteEdits[key] ?? {}
        const ap = vp?.analyte_params
        if (ap) {
          return Object.entries(ap).some(([aKey, aParams]) => {
            const edit = vialEdits[aKey]
            return (
              edit?.conc !== (aParams.target_conc_ug_ml != null ? String(aParams.target_conc_ug_ml) : '') ||
              edit?.vol !== (aParams.target_total_vol_ul != null ? String(aParams.target_total_vol_ul) : '')
            )
          })
        }
        // Legacy fallback
        const edit = vialEdits._vial
        return (
          edit?.conc !== (vp?.target_conc_ug_ml != null ? String(vp.target_conc_ug_ml) : '') ||
          edit?.vol !== (vp?.target_total_vol_ul != null ? String(vp.target_total_vol_ul) : '')
        )
      })
    : declared !== (session.declared_weight_mg != null ? String(session.declared_weight_mg) : '') ||
      conc !== (session.target_conc_ug_ml != null ? String(session.target_conc_ug_ml) : '') ||
      vol !== (session.target_total_vol_ul != null ? String(session.target_total_vol_ul) : '')

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()

    if (isMultiAnalyte) {
      // Build updated vial_params with analyte_params
      const updatedVialParams: Record<string, VialParams> = {}
      for (const key of vialKeys) {
        const existing = vialParamsMap[key]
        const vialEditsMap = analyteEdits[key] ?? {}
        const existingAP = existing?.analyte_params

        const sharedDeclared = parseFloat(declared)
        const newDeclaredVal = !isNaN(sharedDeclared) && sharedDeclared > 0
          ? sharedDeclared
          : existing?.declared_weight_mg ?? null

        if (existingAP) {
          // Per-analyte path — keep individual analyte declared weights, update vial total
          const newAP: Record<string, { declared_weight_mg: number | null; target_conc_ug_ml: number | null; target_total_vol_ul: number | null }> = {}
          let firstConc: number | null = null
          let firstVol: number | null = null
          for (const [aKey, aParams] of Object.entries(existingAP)) {
            const edit = vialEditsMap[aKey]
            const concParsed = parseFloat(edit?.conc ?? '')
            const volParsed = parseFloat(edit?.vol ?? '')
            if (isNaN(concParsed) || isNaN(volParsed) || concParsed <= 0 || volParsed <= 0) {
              setSaveError(`Please enter valid values for ${aKey} in Vial ${key}.`)
              return
            }
            newAP[aKey] = {
              declared_weight_mg: aParams.declared_weight_mg,
              target_conc_ug_ml: concParsed,
              target_total_vol_ul: volParsed,
            }
            if (firstConc === null) firstConc = concParsed
            if (firstVol === null) firstVol = volParsed
          }
          updatedVialParams[key] = {
            declared_weight_mg: newDeclaredVal,
            target_conc_ug_ml: firstConc,
            target_total_vol_ul: firstVol,
            analyte_params: newAP,
          }
        } else {
          // Legacy per-vial fallback
          const edit = vialEditsMap._vial
          const concParsed = parseFloat(edit?.conc ?? '')
          const volParsed = parseFloat(edit?.vol ?? '')
          if (isNaN(concParsed) || isNaN(volParsed) || concParsed <= 0 || volParsed <= 0) {
            setSaveError(`Please enter valid values for Vial ${key}.`)
            return
          }
          updatedVialParams[key] = {
            declared_weight_mg: newDeclaredVal,
            target_conc_ug_ml: concParsed,
            target_total_vol_ul: volParsed,
          }
        }
      }
      setSaving(true)
      setSaveError(null)
      setSaved(false)
      try {
        const v1 = updatedVialParams['1']
        const declaredFinal = parseFloat(declared)
        const updated = await updateWizardSession(session.id, {
          ...(!isNaN(declaredFinal) && declaredFinal > 0 ? { declared_weight_mg: declaredFinal } : {}),
          target_conc_ug_ml: v1?.target_conc_ug_ml ?? undefined,
          target_total_vol_ul: v1?.target_total_vol_ul ?? undefined,
          vial_params: updatedVialParams,
          instrument_id: editInstrumentId ? Number(editInstrumentId) : undefined,
          ...(session.is_standard ? {
            manufacturer: editManufacturer || undefined,
            standard_notes: editStandardNotes || undefined,
          } : {}),
        })
        useWizardStore.getState().updateSession(updated)
        setSaved(true)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save')
      } finally {
        setSaving(false)
      }
    } else {
      const declaredParsed = parseFloat(declared)
      const concParsed = parseFloat(conc)
      const volParsed = parseFloat(vol)
      if (isNaN(concParsed) || isNaN(volParsed) || concParsed <= 0 || volParsed <= 0) {
        setSaveError('Please enter valid values for both fields.')
        return
      }
      setSaving(true)
      setSaveError(null)
      setSaved(false)
      try {
        const updated = await updateWizardSession(session.id, {
          ...(!isNaN(declaredParsed) && declaredParsed > 0 ? { declared_weight_mg: declaredParsed } : {}),
          target_conc_ug_ml: concParsed,
          target_total_vol_ul: volParsed,
          instrument_id: editInstrumentId ? Number(editInstrumentId) : undefined,
          ...(session.is_standard ? {
            manufacturer: editManufacturer || undefined,
            standard_notes: editStandardNotes || undefined,
          } : {}),
        })
        useWizardStore.getState().updateSession(updated)
        setSaved(true)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save')
      } finally {
        setSaving(false)
      }
    }
  }

  function setAnalyteEdit(vialKey: string, analyteKey: string, field: 'conc' | 'vol', value: string) {
    setAnalyteEdits(prev => {
      const vialMap = prev[vialKey] ?? {}
      const current = vialMap[analyteKey] ?? { conc: '', vol: '' }
      return {
        ...prev,
        [vialKey]: { ...vialMap, [analyteKey]: { ...current, [field]: value } },
      }
    })
    setSaved(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Peptide Vial Weight</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Instrument selector — always visible */}
        <div className="space-y-1">
          <Label htmlFor="edit-instrument" className="text-xs">Instrument</Label>
          <Select value={editInstrumentId} onValueChange={v => { setEditInstrumentId(v); setSaved(false); saveInstrumentId(v) }}>
            <SelectTrigger id="edit-instrument" className="h-8 text-xs">
              <SelectValue placeholder="Select instrument…" />
            </SelectTrigger>
            <SelectContent>
              {instruments.map(inst => (
                <SelectItem key={inst.id} value={String(inst.id)}>{inst.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Read-only fields */}
        <div className="rounded-md border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 p-4 space-y-3">
          {/* Standard sample indicator + editable metadata */}
          {session.is_standard && (
            <div className="mb-3 space-y-3">
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                Standard Sample
              </span>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="edit-manufacturer" className="text-xs">Manufacturer</Label>
                  <Input
                    id="edit-manufacturer"
                    className="h-8 text-xs"
                    placeholder="e.g. Bachem"
                    value={editManufacturer}
                    onChange={e => { setEditManufacturer(e.target.value); setSaved(false) }}
                    onBlur={e => saveMetaField('manufacturer', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="edit-standard-notes" className="text-xs">Standard Notes</Label>
                  <Input
                    id="edit-standard-notes"
                    className="h-8 text-xs"
                    placeholder="Optional notes"
                    value={editStandardNotes}
                    onChange={e => { setEditStandardNotes(e.target.value); setSaved(false) }}
                    onBlur={e => saveMetaField('standard_notes', e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">Peptide</span>
              <p className="font-medium">
                {peptide
                  ? `${peptide.name} (${peptide.abbreviation})`
                  : `Peptide ID ${session.peptide_id}`}
                {peptide?.is_blend && (
                  <Badge variant="outline" className="ml-2 text-[10px]">Blend</Badge>
                )}
              </p>
              {peptide?.is_blend && peptide.components.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {peptide.components.map(c => (
                    <Badge key={c.id} variant="secondary" className="text-[10px]">
                      {c.abbreviation}
                      {isMultiVial && c.vial_number != null && (
                        <span className="ml-1 opacity-60">V{c.vial_number}</span>
                      )}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            <div>
              <span className="text-muted-foreground">Sample ID</span>
              <p className="font-medium">{session.sample_id_label ?? '—'}</p>
            </div>
            {!isMultiAnalyte && (
              <div>
                <span className="text-muted-foreground">Declared Weight</span>
                <p className="font-medium">
                  {session.declared_weight_mg != null
                    ? `${session.declared_weight_mg.toFixed(2)} mg`
                    : '—'}
                </p>
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Session ID</span>
              <p className="font-mono text-xs text-muted-foreground">#{session.id}</p>
            </div>
          </div>

          {/* Per-vial / per-analyte read-only declared weights */}
          {isMultiAnalyte && (
            <div className="space-y-2 border-t border-green-500/20 pt-3">
              {vialKeys.map(key => {
                const vp = vialParamsMap[key]
                const vialNum = Number(key)
                const comps = peptide?.components.filter(c => (c.vial_number ?? 1) === vialNum) ?? []
                const analyteParams = vp?.analyte_params
                return (
                  <div key={key} className="space-y-1">
                    <div className="flex items-center gap-3 text-sm">
                      <Badge variant="outline" className="text-[10px] shrink-0">Vial {key}</Badge>
                      <span className="text-xs text-muted-foreground truncate">
                        {comps.map(c => c.abbreviation).join(', ') || '—'}
                      </span>
                      {!analyteParams && (
                        <span className="ml-auto text-xs font-mono shrink-0">
                          {vp?.declared_weight_mg != null ? `${vp.declared_weight_mg} mg` : '—'}
                        </span>
                      )}
                    </div>
                    {analyteParams && Object.entries(analyteParams).map(([aKey, ap]) => (
                      <div key={aKey} className="flex items-center gap-3 text-xs ml-6">
                        <span className="text-muted-foreground">{aKey}</span>
                        <span className="ml-auto font-mono shrink-0">
                          {ap.declared_weight_mg != null ? `${ap.declared_weight_mg} mg` : '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Editable target fields */}
        <form onSubmit={handleSave} className="space-y-3">
          <p className="text-xs text-muted-foreground">
            You can update the target parameters below.
          </p>

          {/* Declared weight — shared across all vials */}
          <div className="space-y-1.5">
            <Label htmlFor="edit-declared-weight">Declared Weight (mg)</Label>
            <Input
              id="edit-declared-weight"
              type="number"
              step="0.01"
              placeholder="e.g. 50.00"
              value={declared}
              onChange={e => { setDeclared(e.target.value); setSaved(false) }}
            />
          </div>

          {isMultiAnalyte ? (
            <div className="space-y-4">
              {vialKeys.map(key => {
                const vialNum = Number(key)
                const comps = peptide?.components.filter(c => (c.vial_number ?? 1) === vialNum) ?? []
                const vp = vialParamsMap[key]
                const hasAnalyteParams = !!vp?.analyte_params
                const analyteKeys = hasAnalyteParams && vp?.analyte_params ? Object.keys(vp.analyte_params) : ['_vial']
                return (
                  <div key={key} className="rounded-md border border-zinc-700 p-3 space-y-3">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">Vial {key}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {comps.map(c => c.abbreviation).join(', ')}
                      </span>
                    </div>
                    {analyteKeys.map(aKey => {
                      const edit = analyteEdits[key]?.[aKey]
                      const displayName = aKey === '_vial' ? comps.map(c => c.abbreviation).join(', ') : aKey
                      return (
                        <div key={aKey} className="rounded border border-zinc-600/50 p-2.5 space-y-2">
                          <p className="text-xs font-medium text-muted-foreground">{displayName}</p>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                              <Label htmlFor={`edit-v${key}-${aKey}-conc`}>
                                Target Conc. (µg/mL) <span className="text-destructive">*</span>
                              </Label>
                              <Input
                                id={`edit-v${key}-${aKey}-conc`}
                                type="number"
                                step="0.1"
                                placeholder="e.g. 1200"
                                value={edit?.conc ?? ''}
                                onChange={e => setAnalyteEdit(key, aKey, 'conc', e.target.value)}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor={`edit-v${key}-${aKey}-vol`}>
                                Target Vol. (µL) <span className="text-destructive">*</span>
                              </Label>
                              <Input
                                id={`edit-v${key}-${aKey}-vol`}
                                type="number"
                                step="0.1"
                                placeholder="e.g. 1500"
                                value={edit?.vol ?? ''}
                                onChange={e => setAnalyteEdit(key, aKey, 'vol', e.target.value)}
                              />
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-target-conc">
                    Target Concentration (µg/mL){' '}
                    <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="edit-target-conc"
                    type="number"
                    step="0.1"
                    placeholder="e.g. 1200"
                    value={conc}
                    onChange={e => { setConc(e.target.value); setSaved(false) }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-target-vol">
                    Target Total Volume (µL){' '}
                    <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="edit-target-vol"
                    type="number"
                    step="0.1"
                    placeholder="e.g. 1500"
                    value={vol}
                    onChange={e => { setVol(e.target.value); setSaved(false) }}
                  />
                </div>
              </div>
          )}

          {saveError && (
            <Alert variant="destructive">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}

          <Button
            type="submit"
            disabled={saving || !isDirty}
            size="sm"
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Saving...
              </>
            ) : saved ? (
              'Saved ✓'
            ) : (
              'Save Changes'
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
