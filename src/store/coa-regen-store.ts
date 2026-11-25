import { create } from 'zustand'

/**
 * Primary-COA regenerations in flight, keyed by sample id.
 *
 * The Regen & Republish button renders inside the Manage popover, whose
 * content unmounts when it closes; local component state would reset and a
 * reopened popover could start a second regen while the first still runs.
 */
interface CoaRegenState {
  inFlight: Record<string, true>
  start: (sampleId: string) => void
  finish: (sampleId: string) => void
}

export const useCoaRegenStore = create<CoaRegenState>(set => ({
  inFlight: {},
  start: sampleId =>
    set(s => ({ inFlight: { ...s.inFlight, [sampleId]: true } })),
  finish: sampleId =>
    set(s => ({
      inFlight: Object.fromEntries(
        Object.entries(s.inFlight).filter(([id]) => id !== sampleId)
      ) as Record<string, true>,
    })),
}))
