import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getHplcSheet,
  patchHplcRow,
  updateWorksheetItem,
  type HplcRowPatch,
  type HplcSheet,
  type HplcSheetRow,
} from '@/lib/api'
import { mergeHplcPrep, type HplcPrepInputs } from '@/lib/hplc-prep'
import { worksheetPageKey } from '@/hooks/use-worksheet-drawer'

/** The HPLC sheet's cache key (GET /worksheets/{id}/hplc). */
export const HPLC_SHEET_KEY = (id: number) => ['hplc-sheet', id] as const

export function useHplcSheet(id: number) {
  return useQuery({
    queryKey: HPLC_SHEET_KEY(id),
    queryFn: () => getHplcSheet(id),
  })
}

type Plain = Record<string, unknown>
const isPlain = (x: unknown): x is Plain =>
  x !== null && typeof x === 'object' && !Array.isArray(x)

/** The merge patch that puts back what `patch` overwrote: each leaf it sent
 *  at its value in `before`, or null where there was none. */
function undoPatch(before: unknown, patch: Plain): Plain {
  const out: Plain = {}
  for (const [key, value] of Object.entries(patch)) {
    const was = isPlain(before) ? before[key] : undefined
    out[key] = isPlain(value) ? undoPatch(was, value) : (was ?? null)
  }
  return out
}

/** The row with `body` applied as the server will apply it. A prep_form
 *  sent as null goes back to the sample's own form (bac, else its form's). */
function applied(row: HplcSheetRow, body: HplcRowPatch): HplcSheetRow {
  const next = { ...row }
  if (body.hplc_prep)
    next.hplc_prep = mergeHplcPrep(row.hplc_prep, body.hplc_prep)
  if (body.prep_form !== undefined) {
    next.prep_form = body.prep_form
    next.form =
      body.prep_form ??
      (row.sample_bac ? 'bac' : (row.sample_form?.hplc_prep ?? null))
  }
  return next
}

/**
 * One cell's save. Optimistic through mergeHplcPrep; a failure puts back
 * only the keys that save wrote (several saves can be in flight on one
 * sheet, and a whole-sheet snapshot would undo the ones that succeeded),
 * and the mutation's error carries the server's reason for the page.
 */
export function usePatchHplcRow(id: number) {
  const queryClient = useQueryClient()
  const key = HPLC_SHEET_KEY(id)
  const setRow = (itemId: number, fn: (row: HplcSheetRow) => HplcSheetRow) =>
    queryClient.setQueryData<HplcSheet>(key, sheet =>
      sheet
        ? {
            ...sheet,
            rows: sheet.rows.map(r => (r.item_id === itemId ? fn(r) : r)),
          }
        : sheet
    )
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: number; body: HplcRowPatch }) =>
      patchHplcRow(id, itemId, body),
    onMutate: async ({ itemId, body }) => {
      await queryClient.cancelQueries({ queryKey: key })
      const before = queryClient
        .getQueryData<HplcSheet>(key)
        ?.rows.find(r => r.item_id === itemId)
      setRow(itemId, row => applied(row, body))
      return { before }
    },
    onError: (_err, { itemId, body }, context) => {
      const before = context?.before
      if (!before) return
      setRow(itemId, row => {
        const back: HplcSheetRow = body.hplc_prep
          ? {
              ...row,
              hplc_prep: mergeHplcPrep(
                row.hplc_prep,
                undoPatch(
                  before.hplc_prep,
                  body.hplc_prep as Plain
                ) as HplcPrepInputs
              ),
            }
          : { ...row }
        if (body.prep_form !== undefined) {
          back.prep_form = before.prep_form
          back.form = before.form
        }
        return back
      })
    },
    onSuccess: (row, { itemId }) => setRow(itemId, () => row),
  })
}

/** The row's instrument, through the existing item PATCH; the sheet and the
 *  worksheet page refetch after (the instrument's name and method follow). */
export function useSetHplcInstrument(id: number) {
  const queryClient = useQueryClient()
  const setInstrument = (
    itemId: number,
    instrumentId: number | null,
    name: string | null
  ) =>
    queryClient.setQueryData<HplcSheet>(HPLC_SHEET_KEY(id), sheet =>
      sheet
        ? {
            ...sheet,
            rows: sheet.rows.map(r =>
              r.item_id === itemId
                ? { ...r, instrument_id: instrumentId, instrument_name: name }
                : r
            ),
          }
        : sheet
    )
  return useMutation({
    mutationFn: ({
      itemId,
      instrumentId,
    }: {
      itemId: number
      instrumentId: number | null
    }) => updateWorksheetItem(id, itemId, { instrument_id: instrumentId }),
    // Optimistic, so the select does not sit on its old value until the
    // refetch lands; a failure puts back that row's instrument only.
    onMutate: async ({ itemId, instrumentId }) => {
      await queryClient.cancelQueries({ queryKey: HPLC_SHEET_KEY(id) })
      const before = queryClient
        .getQueryData<HplcSheet>(HPLC_SHEET_KEY(id))
        ?.rows.find(r => r.item_id === itemId)
      setInstrument(itemId, instrumentId, null)
      return { before }
    },
    onError: (_err, { itemId }, context) => {
      if (context?.before)
        setInstrument(
          itemId,
          context.before.instrument_id,
          context.before.instrument_name
        )
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: HPLC_SHEET_KEY(id) })
      void queryClient.invalidateQueries({ queryKey: worksheetPageKey(id) })
    },
  })
}
