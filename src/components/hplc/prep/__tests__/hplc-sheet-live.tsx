import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import type { HplcRowPatch, HplcSheetRow } from '@/lib/api'
import { mergeHplcPrep } from '@/lib/hplc-prep'
import type { HplcPrepRule } from '@/lib/hplc-prep-rules'
import { HplcPrepSheet } from '../HplcPrepSheet'
import { INSTRUMENTS, makeSheet } from './hplc-sheet-fixtures'

/**
 * The sheet with its rows held in state: each patch is merged as the server
 * merges it, so a test sees the sheet re-plan from what was sent.
 */
export function renderLive(
  rows: HplcSheetRow[],
  {
    rules = [] as HplcPrepRule[],
    readOnly = false,
    failed = undefined as ReadonlyMap<string, string> | undefined,
  } = {}
) {
  const onPatch =
    vi.fn<(id: number, patch: HplcRowPatch, what: string) => void>()
  function Live() {
    const [sheet, setSheet] = useState(() => makeSheet(rows))
    return (
      <HplcPrepSheet
        sheet={sheet}
        rules={rules}
        readOnly={readOnly}
        failed={failed}
        instruments={INSTRUMENTS}
        onPatch={(id, patch, what) => {
          onPatch(id, patch, what)
          setSheet(s => ({
            ...s,
            rows: s.rows.map(r =>
              r.item_id === id
                ? {
                    ...r,
                    hplc_prep: mergeHplcPrep(
                      r.hplc_prep,
                      patch.hplc_prep ?? {}
                    ),
                  }
                : r
            ),
          }))
        }}
        onSetInstrument={vi.fn()}
      />
    )
  }
  render(<Live />)
  return { onPatch }
}

export const region = (name: string) => screen.getByRole('region', { name })
export const queryRegion = (name: string) =>
  screen.queryByRole('region', { name })

export const STEP2B = 'Step 2b Blend components'
export const STEP3A = 'Step 3a Intermediate dilution'
export const STEP3 = 'Step 3 Peptide dilution into the autosampler vial'
