import { useState, useEffect } from 'react'
import { FlaskConical, Loader2, Beaker } from 'lucide-react'
import { useWizardStore } from '@/store/wizard-store'
import { getMethods, type HplcMethod } from '@/lib/api'

/** Left-hand info panel shown during the wizard after peptide selection. */
export function WizardInfoPanel() {
  const senaiteResult = useWizardStore(state => state.senaiteResult)
  const selectedPeptide = useWizardStore(state => state.selectedPeptide)
  const session = useWizardStore(state => state.session)
  const blendComponents = useWizardStore(state => state.blendComponents)
  const currentStep = useWizardStore(state => state.currentStep)
  const wizardSteps = useWizardStore(state => state.wizardSteps)

  // Only show the panel once a session exists (peptide selected)
  if (!session) return null

  // Determine active vial from the current step
  const currentStepDef = wizardSteps.find(s => s.id === currentStep)
  const activeVial = currentStepDef?.vialNumber ?? 1
  const isMultiVial = blendComponents.some(c => c.vial_number != null && c.vial_number > 1)

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4">
      {/* SENAITE Sample Info */}
      {senaiteResult && <SenaiteCard senaiteResult={senaiteResult} />}

      {/* Vial details — context-aware based on active step */}
      <VialDetailsCard
        session={session}
        activeVial={activeVial}
        isMultiVial={isMultiVial}
        blendComponents={blendComponents}
        peptideName={selectedPeptide?.name}
        peptideAbbr={selectedPeptide?.abbreviation}
        senaiteResult={senaiteResult}
      />

      {/* Methods */}
      {selectedPeptide && (
        <MethodsSection
          peptide={selectedPeptide}
          blendComponents={blendComponents}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SENAITE card
// ---------------------------------------------------------------------------

function SenaiteCard({ senaiteResult }: { senaiteResult: NonNullable<ReturnType<typeof useWizardStore.getState>['senaiteResult']> }) {
  return (
    <div className="rounded-md border border-blue-500/30 bg-blue-50/50 dark:bg-blue-950/20 p-3 space-y-2">
      <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 uppercase tracking-wider">
        SENAITE Sample
      </p>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <span className="text-muted-foreground text-xs">Sample ID</span>
          <p className="font-medium text-sm">{senaiteResult.sample_id}</p>
        </div>
        <div>
          <span className="text-muted-foreground text-xs">Declared Weight</span>
          <p className="font-medium text-sm">
            {senaiteResult.declared_weight_mg != null
              ? `${senaiteResult.declared_weight_mg} mg`
              : '—'}
          </p>
        </div>
      </div>
      {senaiteResult.analytes.length > 0 && (
        <div>
          <span className="text-xs text-muted-foreground">Analytes</span>
          <ul className="mt-0.5 space-y-0.5">
            {senaiteResult.analytes.map((a, i) => (
              <li key={i} className="text-xs flex items-center gap-1.5">
                <span
                  className={
                    a.matched_peptide_id !== null
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-muted-foreground'
                  }
                >
                  {a.matched_peptide_id !== null ? '✓' : '○'}
                </span>
                <span className="truncate">{a.raw_name}</span>
                {a.declared_quantity != null && (
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-foreground">
                    {a.declared_quantity} mg
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vial details card — shows context for the active vial
// ---------------------------------------------------------------------------

function VialDetailsCard({
  session,
  activeVial,
  isMultiVial,
  blendComponents,
  peptideName,
  peptideAbbr,
  senaiteResult,
}: {
  session: NonNullable<ReturnType<typeof useWizardStore.getState>['session']>
  activeVial: number
  isMultiVial: boolean
  blendComponents: ReturnType<typeof useWizardStore.getState>['blendComponents']
  peptideName?: string
  peptideAbbr?: string
  senaiteResult: ReturnType<typeof useWizardStore.getState>['senaiteResult']
}) {
  // Components assigned to this vial
  const vialComponents = isMultiVial
    ? blendComponents.filter(c => c.vial_number === activeVial)
    : blendComponents

  // Per-vial params (from vial_params) or fall back to session-level values
  const vialParams = session.vial_params?.[String(activeVial)]
  const targetConc = vialParams?.target_conc_ug_ml ?? session.target_conc_ug_ml
  const targetVol = vialParams?.target_total_vol_ul ?? session.target_total_vol_ul
  const declaredWt = vialParams?.declared_weight_mg ?? session.declared_weight_mg

  // Match SENAITE analytes to this vial's components
  const vialComponentIds = new Set(vialComponents.map(c => c.id))
  const vialAnalytes = senaiteResult?.analytes.filter(
    a => a.matched_peptide_id !== null && vialComponentIds.has(a.matched_peptide_id)
  ) ?? []

  const title = isMultiVial ? `Vial ${activeVial} Details` : 'Prep Details'

  return (
    <div className="rounded-md border border-primary/30 p-3 space-y-2">
      <p className="text-xs font-semibold text-primary uppercase tracking-wider">
        {title}
      </p>

      {/* Peptide name (single peptide or blend name) */}
      {peptideName && (
        <div>
          <span className="text-muted-foreground text-xs">Peptide</span>
          <p className="font-medium text-sm">
            {peptideName}
            {peptideAbbr && <span className="text-muted-foreground ml-1">({peptideAbbr})</span>}
          </p>
        </div>
      )}

      {/* Analytes assigned to this vial */}
      {isMultiVial && vialComponents.length > 0 && (
        <div>
          <span className="text-xs text-muted-foreground">Analytes for this vial</span>
          <ul className="mt-0.5 space-y-0.5">
            {vialComponents.map(comp => {
              const analyte = vialAnalytes.find(a => a.matched_peptide_id === comp.id)
              return (
                <li key={comp.id} className="text-xs flex items-center gap-1.5">
                  <FlaskConical className="h-3 w-3 text-primary/70 shrink-0" />
                  <span className="truncate">{comp.name}</span>
                  <span className="text-muted-foreground">({comp.abbreviation})</span>
                  {analyte?.declared_quantity != null && (
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-foreground">
                      {analyte.declared_quantity} mg
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Target parameters */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {session.sample_id_label && (
          <div>
            <span className="text-muted-foreground">Sample ID</span>
            <p className="font-medium">{session.sample_id_label}</p>
          </div>
        )}
        {targetConc != null && (
          <div>
            <span className="text-muted-foreground">Target Conc.</span>
            <p className="font-medium font-mono">{targetConc} µg/mL</p>
          </div>
        )}
        {targetVol != null && (
          <div>
            <span className="text-muted-foreground">Target Vol.</span>
            <p className="font-medium font-mono">{targetVol} µL</p>
          </div>
        )}
        {declaredWt != null && (
          <div>
            <span className="text-muted-foreground">Declared Wt.</span>
            <p className="font-medium font-mono">{declaredWt} mg</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Methods section
// ---------------------------------------------------------------------------

function MethodsSection({
  peptide,
  blendComponents,
}: {
  peptide: NonNullable<ReturnType<typeof useWizardStore.getState>['selectedPeptide']>
  blendComponents: ReturnType<typeof useWizardStore.getState>['blendComponents']
}) {
  const [methods, setMethods] = useState<HplcMethod[]>([])
  const [loading, setLoading] = useState(false)

  const isBlend = peptide.is_blend && blendComponents.length > 0

  // Fetch methods — match by peptide's own methods OR by component peptide IDs
  // (a method's common_peptides lists which peptides use it)
  useEffect(() => {
    let cancelled = false
    setLoading(true)

    getMethods()
      .then(allMethods => {
        if (cancelled) return

        // Direct method IDs from the peptide record (e.g. KLOW has its own method)
        const directMethodIds = new Set(peptide.methods.map(m => m.id))
        const directMatches = allMethods.filter(m => directMethodIds.has(m.id))

        // If the blend has direct methods, prefer those exclusively.
        // Only fall back to component-level matching if no direct methods exist.
        if (directMatches.length > 0) {
          setMethods(directMatches)
          return
        }

        // For blends without direct methods: find methods whose common_peptides
        // include any component peptide
        if (isBlend) {
          const componentIds = new Set(blendComponents.map(c => c.id))
          const componentMatches = allMethods.filter(m =>
            m.common_peptides?.some(p => componentIds.has(p.id))
          )
          setMethods(componentMatches)
          return
        }

        setMethods([])
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [peptide.methods, blendComponents, isBlend])

  if (!loading && methods.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Beaker className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Methods
        </span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading methods...
        </div>
      ) : (
        <div className="space-y-2">
          {methods.map(method => (
            <MethodCard
              key={method.id}
              method={method}
              isBlend={isBlend}
              blendComponents={blendComponents}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function MethodCard({
  method,
  isBlend,
  blendComponents,
}: {
  method: HplcMethod
  isBlend: boolean
  blendComponents: ReturnType<typeof useWizardStore.getState>['blendComponents']
}) {
  // For blends: show which component peptides use this method
  const methodPeptideIds = new Set(method.common_peptides?.map(p => p.id) ?? [])
  const relatedComps = isBlend
    ? blendComponents.filter(c => methodPeptideIds.has(c.id))
    : []

  return (
    <div className="rounded-md border p-3 space-y-2">
      {/* Header: name + SENAITE ID */}
      <div>
        <p className="text-sm font-semibold leading-tight">{method.name}</p>
        {method.senaite_id && (
          <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{method.senaite_id}</p>
        )}
        {isBlend && relatedComps.length > 0 && (
          <div className="flex items-center gap-1 mt-1">
            <FlaskConical className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-[10px] text-muted-foreground truncate">
              {relatedComps.map(c => c.abbreviation).join(', ')}
            </span>
          </div>
        )}
      </div>

      {/* All method fields in a grid */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        {method.instrument && (
          <div>
            <span className="text-muted-foreground">Instrument</span>
            <p className="font-medium">{method.instrument.name}</p>
          </div>
        )}
        {method.size_peptide && (
          <div>
            <span className="text-muted-foreground">Size Peptide</span>
            <p className="font-medium">{method.size_peptide}</p>
          </div>
        )}
        {method.starting_organic_pct != null && (
          <div>
            <span className="text-muted-foreground">Starting Organic</span>
            <p className="font-medium font-mono">{method.starting_organic_pct}%</p>
          </div>
        )}
        {method.temperature_mct_c != null && (
          <div>
            <span className="text-muted-foreground">MCT Temp</span>
            <p className="font-medium font-mono">{method.temperature_mct_c} °C</p>
          </div>
        )}
        {method.dissolution && (
          <div className="col-span-2">
            <span className="text-muted-foreground">Dissolution</span>
            <p className="font-medium">{method.dissolution}</p>
          </div>
        )}
      </div>

      {/* Notes */}
      {method.notes && (
        <div className="border-t border-border/50 pt-1.5 mt-1">
          <span className="text-[10px] text-muted-foreground">Notes: </span>
          <span className="text-[10px] text-foreground">{method.notes}</span>
        </div>
      )}
    </div>
  )
}
