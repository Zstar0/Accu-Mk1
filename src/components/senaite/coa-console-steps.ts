/** COA console step lists for Sample Details. Pure data, no React, so the
 *  component file keeps exporting only components (fast refresh). */
import type { ReadSource } from '@/lib/read-source'

export interface StepDef {
  id: string
  label: string
  /** ms from operation start when this step begins "running" */
  delay: number
}

// Step labels mirror what the backend actually does per COA source: with
// coa_generation=mk1 the wire document is assembled from the native
// registry (zero SENAITE reads, read-independence). The PDF attach and the
// publish transition still write to SENAITE for SENAITE-born samples in both
// modes; a native-born sample has no AR, so those two labels switch to the
// sample registry (ConsoleStepOptions.nativeBorn). Step ids
// are load-bearing (inferErrorStepIdx maps failure text onto them); only the
// label varies. Sub-sample (-SXX) COAs stay SENAITE-sourced regardless of
// the toggle, so callers pass 'senaite' for non-parents (same rule as
// coaSourceBadgeLabel).
export interface ConsoleStepOptions {
  /** The sample was born in Mk1 (external_lims_system === 'mk1'): it has no
   *  SENAITE AR, so the backend skips the SENAITE attach on generate and
   *  relays the native status on publish instead of a SENAITE transition.
   *  Only the labels change; step ids stay load-bearing for inferErrorStepIdx. */
  nativeBorn?: boolean
}

export function generateSteps(
  source: ReadSource,
  { nativeBorn = false }: ConsoleStepOptions = {}
): StepDef[] {
  return [
    {
      id: 'senaite',
      label:
        source === 'mk1' ? 'Reading sample registry' : 'Connecting to SENAITE',
      delay: 0,
    },
    { id: 'coabuilder', label: 'Running COABuilder', delay: 700 },
    { id: 'verification', label: 'Reserving verification code', delay: 3800 },
    { id: 's3', label: 'Uploading PDF to S3', delay: 4800 },
    {
      id: 'attach',
      label: nativeBorn
        ? 'Recording in sample registry'
        : 'Attaching to SENAITE',
      delay: 6200,
    },
  ]
}

export function publishSteps({
  nativeBorn = false,
}: ConsoleStepOptions = {}): StepDef[] {
  return [
    { id: 'draft', label: 'Locating draft generation', delay: 0 },
    { id: 'primary', label: 'Publishing primary COA', delay: 500 },
    { id: 'additional', label: 'Publishing additional COAs', delay: 1600 },
    { id: 'wordpress', label: 'Notifying WordPress', delay: 2700 },
    {
      id: 'senaite_tx',
      label: nativeBorn ? 'Updating sample registry' : 'SENAITE transition',
      delay: 3700,
    },
  ]
}
