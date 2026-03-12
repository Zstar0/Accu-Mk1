import { useState, useEffect } from 'react'
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
  createWizardSession,
  updateWizardSession,
  getSenaiteStatus,
  lookupSenaiteSample,
  type PeptideRecord,
  type SenaiteLookupResult,
  type WizardSessionResponse,
} from '@/lib/api'
import { useWizardStore } from '@/store/wizard-store'

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

  // Multi-vial state: per-vial declared weight, target conc, target vol
  const [vialParamsState, setVialParamsState] = useState<Record<string, { declaredWeight: string; targetConc: string; targetVol: string }>>({})

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

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

    return () => {
      cancelled = true
    }
  }, [])

  // Multi-vial helpers (must be before early return)
  const isMultiVial = (peptides.find(p => p.id === peptideId)?.prep_vial_count ?? 1) > 1
  const vialCount = peptides.find(p => p.id === peptideId)?.prep_vial_count ?? 1
  const selectedPeptideForVials = peptideId !== null ? peptides.find(p => p.id === peptideId) : null

  function getVialParam(vial: number, field: 'declaredWeight' | 'targetConc' | 'targetVol'): string {
    return vialParamsState[String(vial)]?.[field] ?? ''
  }
  function setVialParam(vial: number, field: 'declaredWeight' | 'targetConc' | 'targetVol', value: string) {
    setVialParamsState(prev => ({
      ...prev,
      [String(vial)]: {
        declaredWeight: prev[String(vial)]?.declaredWeight ?? '',
        targetConc: prev[String(vial)]?.targetConc ?? '',
        targetVol: prev[String(vial)]?.targetVol ?? '',
        [field]: value,
      },
    }))
  }

  // Initialize vial params when peptide changes to multi-vial
  useEffect(() => {
    if (!isMultiVial) return
    setVialParamsState(prev => {
      const next = { ...prev }
      for (let v = 1; v <= vialCount; v++) {
        if (!next[String(v)]) {
          next[String(v)] = { declaredWeight: '', targetConc: '', targetVol: '' }
        }
      }
      return next
    })
  }, [isMultiVial, vialCount, peptideId])

  // Auto-populate per-vial declared weights from SENAITE analyte declared_quantity
  useEffect(() => {
    if (!isMultiVial || !selectedPeptideForVials || !lookupResult) return
    const newState: Record<string, { declaredWeight: string; targetConc: string; targetVol: string }> = {}
    for (let v = 1; v <= vialCount; v++) {
      const compsInVial = selectedPeptideForVials.components.filter(c => (c.vial_number ?? 1) === v)
      let totalDeclared = 0
      let found = false
      for (const comp of compsInVial) {
        const analyte = lookupResult.analytes.find(a => a.matched_peptide_id === comp.id)
        if (analyte?.declared_quantity != null) {
          totalDeclared += analyte.declared_quantity
          found = true
        }
      }
      newState[String(v)] = {
        declaredWeight: found ? String(totalDeclared) : '',
        targetConc: '',
        targetVol: '',
      }
    }
    setVialParamsState(newState)
  }, [lookupResult, isMultiVial, vialCount, peptideId, selectedPeptideForVials])

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

  // For multi-vial: all vials must have target conc + vol filled
  const multiVialReady = isMultiVial
    ? Array.from({ length: vialCount }, (_, i) => i + 1).every(v => {
        const vp = vialParamsState[String(v)]
        return vp && vp.targetConc.trim() !== '' && vp.targetVol.trim() !== ''
      })
    : true

  const canSubmit =
    peptideId !== null &&
    (isMultiVial ? multiVialReady : (targetConcUgMl.trim() !== '' && targetTotalVolUl.trim() !== '')) &&
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

      if (isMultiVial) {
        // Multi-vial: send vial_params, use vial 1 values for backward-compat flat fields
        const vialParams: Record<string, { declared_weight_mg: number | null; target_conc_ug_ml: number | null; target_total_vol_ul: number | null }> = {}
        for (let v = 1; v <= vialCount; v++) {
          const vp = vialParamsState[String(v)]
          if (!vp) continue
          const dw = parseFloat(vp.declaredWeight)
          const tc = parseFloat(vp.targetConc)
          const tv = parseFloat(vp.targetVol)
          vialParams[String(v)] = {
            declared_weight_mg: isNaN(dw) ? null : dw,
            target_conc_ug_ml: isNaN(tc) ? null : tc,
            target_total_vol_ul: isNaN(tv) ? null : tv,
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
      useWizardStore.getState().setCurrentStep(2)
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Failed to create session'
      )
    } finally {
      setSubmitting(false)
    }
  }

  function handleTabChange(tab: string) {
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
              {peptides.map(p => (
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

  // Per-vial fields for multi-vial blends
  const perVialFields = isMultiVial && selectedPeptide ? (
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
            <div className="space-y-1.5">
              <Label htmlFor={`vial-${v}-weight`}>Declared Weight (mg)</Label>
              <Input
                id={`vial-${v}-weight`}
                type="number"
                step="0.01"
                placeholder="e.g. 10.00"
                value={getVialParam(v, 'declaredWeight')}
                onChange={e => setVialParam(v, 'declaredWeight', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`vial-${v}-conc`}>
                Target Concentration (µg/mL) <span className="text-destructive">*</span>
              </Label>
              <Input
                id={`vial-${v}-conc`}
                type="number"
                step="0.1"
                placeholder="e.g. 1200"
                value={getVialParam(v, 'targetConc')}
                onChange={e => setVialParam(v, 'targetConc', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`vial-${v}-vol`}>
                Target Total Volume (µL) <span className="text-destructive">*</span>
              </Label>
              <Input
                id={`vial-${v}-vol`}
                type="number"
                step="0.1"
                placeholder="e.g. 1200"
                value={getVialParam(v, 'targetVol')}
                onChange={e => setVialParam(v, 'targetVol', e.target.value)}
              />
            </div>
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

                {/* Declared Weight + Target fields — single-vial or per-vial */}
                {lookupResult && isMultiVial ? (
                  perVialFields
                ) : lookupResult ? (
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

                {/* Declared Weight + Target fields — single or multi-vial */}
                {isMultiVial ? perVialFields : (
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
                )}

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

            {/* Declared Weight + Target fields — single or multi-vial */}
            {isMultiVial ? perVialFields : (
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
            )}

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

  // Single-vial editable state
  const [conc, setConc] = useState(
    session.target_conc_ug_ml != null ? String(session.target_conc_ug_ml) : ''
  )
  const [vol, setVol] = useState(
    session.target_total_vol_ul != null ? String(session.target_total_vol_ul) : ''
  )

  // Multi-vial editable state
  const [vialEdits, setVialEdits] = useState<Record<string, { conc: string; vol: string }>>(() => {
    if (!isMultiVial) return {}
    const init: Record<string, { conc: string; vol: string }> = {}
    for (const key of vialKeys) {
      const vp = vialParamsMap[key]
      init[key] = {
        conc: vp?.target_conc_ug_ml != null ? String(vp.target_conc_ug_ml) : '',
        vol: vp?.target_total_vol_ul != null ? String(vp.target_total_vol_ul) : '',
      }
    }
    return init
  })

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const isDirty = isMultiVial
    ? vialKeys.some(key => {
        const vp = vialParamsMap[key]
        const edit = vialEdits[key]
        return (
          edit?.conc !== (vp?.target_conc_ug_ml != null ? String(vp.target_conc_ug_ml) : '') ||
          edit?.vol !== (vp?.target_total_vol_ul != null ? String(vp.target_total_vol_ul) : '')
        )
      })
    : conc !== (session.target_conc_ug_ml != null ? String(session.target_conc_ug_ml) : '') ||
      vol !== (session.target_total_vol_ul != null ? String(session.target_total_vol_ul) : '')

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()

    if (isMultiVial) {
      // Build updated vial_params
      const updatedVialParams: Record<string, { declared_weight_mg: number | null; target_conc_ug_ml: number | null; target_total_vol_ul: number | null }> = {}
      for (const key of vialKeys) {
        const edit = vialEdits[key]
        const existing = vialParamsMap[key]
        const concParsed = parseFloat(edit?.conc ?? '')
        const volParsed = parseFloat(edit?.vol ?? '')
        if (isNaN(concParsed) || isNaN(volParsed) || concParsed <= 0 || volParsed <= 0) {
          setSaveError(`Please enter valid values for Vial ${key}.`)
          return
        }
        updatedVialParams[key] = {
          declared_weight_mg: existing?.declared_weight_mg ?? null,
          target_conc_ug_ml: concParsed,
          target_total_vol_ul: volParsed,
        }
      }
      setSaving(true)
      setSaveError(null)
      setSaved(false)
      try {
        // Update with vial 1 flat values for backward compat + full vial_params
        const v1 = updatedVialParams['1']
        const updated = await updateWizardSession(session.id, {
          target_conc_ug_ml: v1?.target_conc_ug_ml ?? undefined,
          target_total_vol_ul: v1?.target_total_vol_ul ?? undefined,
          vial_params: updatedVialParams,
        })
        useWizardStore.getState().updateSession(updated)
        setSaved(true)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save')
      } finally {
        setSaving(false)
      }
    } else {
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
          target_conc_ug_ml: concParsed,
          target_total_vol_ul: volParsed,
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

  function setVialEdit(key: string, field: 'conc' | 'vol', value: string) {
    setVialEdits(prev => ({
      ...prev,
      [key]: { conc: '', vol: '', ...prev[key], [field]: value },
    }))
    setSaved(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Peptide Vial Weight</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Read-only fields */}
        <div className="rounded-md border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 p-4 space-y-3">
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
            {!isMultiVial && (
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

          {/* Per-vial read-only declared weights */}
          {isMultiVial && (
            <div className="space-y-2 border-t border-green-500/20 pt-3">
              {vialKeys.map(key => {
                const vp = vialParamsMap[key]
                const vialNum = Number(key)
                const comps = peptide?.components.filter(c => (c.vial_number ?? 1) === vialNum) ?? []
                return (
                  <div key={key} className="flex items-center gap-3 text-sm">
                    <Badge variant="outline" className="text-[10px] shrink-0">Vial {key}</Badge>
                    <span className="text-xs text-muted-foreground truncate">
                      {comps.map(c => c.abbreviation).join(', ') || '—'}
                    </span>
                    <span className="ml-auto text-xs font-mono shrink-0">
                      {vp?.declared_weight_mg != null ? `${vp.declared_weight_mg} mg` : '—'}
                    </span>
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

          {isMultiVial ? (
            <div className="space-y-4">
              {vialKeys.map(key => {
                const vialNum = Number(key)
                const comps = peptide?.components.filter(c => (c.vial_number ?? 1) === vialNum) ?? []
                const edit = vialEdits[key]
                return (
                  <div key={key} className="rounded-md border border-zinc-700 p-3 space-y-3">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">Vial {key}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {comps.map(c => c.abbreviation).join(', ')}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor={`edit-v${key}-conc`}>
                          Target Conc. (µg/mL) <span className="text-destructive">*</span>
                        </Label>
                        <Input
                          id={`edit-v${key}-conc`}
                          type="number"
                          step="0.1"
                          placeholder="e.g. 1200"
                          value={edit?.conc ?? ''}
                          onChange={e => setVialEdit(key, 'conc', e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`edit-v${key}-vol`}>
                          Target Vol. (µL) <span className="text-destructive">*</span>
                        </Label>
                        <Input
                          id={`edit-v${key}-vol`}
                          type="number"
                          step="0.1"
                          placeholder="e.g. 1500"
                          value={edit?.vol ?? ''}
                          onChange={e => setVialEdit(key, 'vol', e.target.value)}
                        />
                      </div>
                    </div>
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
