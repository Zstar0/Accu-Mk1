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
import {
  getPeptides,
  createWizardSession,
  getSenaiteStatus,
  lookupSenaiteSample,
  type PeptideRecord,
  type SenaiteLookupResult,
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

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // SENAITE state
  const [senaiteEnabled, setSenaiteEnabled] = useState(false)
  const [checkingStatus, setCheckingStatus] = useState(true)
  const [activeTab, setActiveTab] = useState<'lookup' | 'manual'>('manual')

  // Lookup state
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

  // If session already exists — show read-only summary (UNCHANGED)
  if (session !== null) {
    const peptide = peptides.find(p => p.id === session.peptide_id)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Sample Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">Peptide</span>
                <p className="font-medium">
                  {peptide
                    ? `${peptide.name} (${peptide.abbreviation})`
                    : `Peptide ID ${session.peptide_id}`}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Sample ID</span>
                <p className="font-medium">
                  {session.sample_id_label ?? '—'}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Declared Weight</span>
                <p className="font-medium">
                  {session.declared_weight_mg != null
                    ? `${session.declared_weight_mg.toFixed(2)} mg`
                    : '—'}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">
                  Target Concentration
                </span>
                <p className="font-medium">
                  {session.target_conc_ug_ml != null
                    ? `${session.target_conc_ug_ml.toFixed(1)} ug/mL`
                    : '—'}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">
                  Target Total Volume
                </span>
                <p className="font-medium">
                  {session.target_total_vol_ul != null
                    ? `${session.target_total_vol_ul.toFixed(1)} uL`
                    : '—'}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Session ID</span>
                <p className="font-mono text-xs text-muted-foreground">
                  #{session.id}
                </p>
              </div>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Session created. Proceed to Stock Prep.
          </p>
        </CardContent>
      </Card>
    )
  }

  const canSubmit =
    peptideId !== null &&
    targetConcUgMl.trim() !== '' &&
    targetTotalVolUl.trim() !== '' &&
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
      if (declaredWeightMg.trim()) {
        const parsed = parseFloat(declaredWeightMg)
        if (!isNaN(parsed)) data.declared_weight_mg = parsed
      }
      const concParsed = parseFloat(targetConcUgMl)
      if (!isNaN(concParsed)) data.target_conc_ug_ml = concParsed
      const volParsed = parseFloat(targetTotalVolUl)
      if (!isNaN(volParsed)) data.target_total_vol_ul = volParsed

      const response = await createWizardSession(data)
      useWizardStore.getState().startSession(response)
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
      // Auto-populate fields from SENAITE data
      setSampleIdLabel(result.sample_id)
      if (result.declared_weight_mg != null) {
        setDeclaredWeightMg(String(result.declared_weight_mg))
      }
      // Auto-select first matched peptide (first match wins)
      const firstMatch = result.analytes.find(a => a.matched_peptide_id !== null)
      if (firstMatch?.matched_peptide_id != null) {
        setPeptideId(firstMatch.matched_peptide_id)
      }
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Lookup failed')
    } finally {
      setLookupLoading(false)
    }
  }

  // Shared peptide dropdown (used in both tabs)
  const peptideDropdown = (
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
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )

  // Shared target fields (appear below lookup summary card or in manual form)
  const targetFields = (
    <>
      {/* Target Concentration */}
      <div className="space-y-1.5">
        <Label htmlFor="target-conc">
          Target Concentration (ug/mL){' '}
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
          Target Total Volume (uL){' '}
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sample Information</CardTitle>
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

                {/* Target fields (below summary card) */}
                {lookupResult && targetFields}

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

                {/* Declared Weight */}
                <div className="space-y-1.5">
                  <Label htmlFor="declared-weight">Declared Weight (mg)</Label>
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

            {/* Declared Weight */}
            <div className="space-y-1.5">
              <Label htmlFor="declared-weight">Declared Weight (mg)</Label>
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
