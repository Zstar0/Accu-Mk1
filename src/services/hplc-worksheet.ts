import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import {
  getHplcPrepRules,
  getHplcSheet,
  patchHplcRow,
  promoteHplcRow,
  updateWorksheetItem,
  type HplcRowPatch,
  type HplcSheet,
  type HplcSheetRow,
} from '@/lib/api'
import { mergeHplcPrep, type HplcPrepInputs } from '@/lib/hplc-prep'
import type { HplcPrepRule } from '@/lib/hplc-prep-rules'
import { HPLC_PREP_RULES_KEY } from '@/services/hplc-prep-rules'
import { worksheetPageKey } from '@/hooks/use-worksheet-drawer'

/** The HPLC sheet's cache key (GET /worksheets/{id}/hplc). */
export const HPLC_SHEET_KEY = (id: number) => ['hplc-sheet', id] as const

/** Every save on one sheet (a cell's PATCH, an instrument), so each can
 *  see the others in flight. */
const SAVE_KEY = (id: number) => ['hplc-sheet-save', id] as const

export function useHplcSheet(id: number) {
  return useQuery({
    queryKey: HPLC_SHEET_KEY(id),
    queryFn: () => getHplcSheet(id),
  })
}

/** A save that did not land: which box ("<sample id>, <column>") and why. */
export type HplcSaveFailure = (what: string, reason: string) => void

type Plain = Record<string, unknown>
const isPlain = (x: unknown): x is Plain =>
  x !== null && typeof x === 'object' && !Array.isArray(x)

interface SaveVars {
  itemId: number
  /** The box, for a failure: "<sample id>, <column>". */
  what: string
  body?: HplcRowPatch
  instrumentId?: number | null
}

/** How long a save may go unanswered. The saves on a sheet queue behind
 *  each other, so one that never answers would hold up every later one. */
const SAVE_TIMEOUT_MS = 15_000
const TIMED_OUT = 'the save timed out; check the value and try again'
// The server may have finished after the browser gave up, so this never
// says the row was not promoted; a second press answers "already".
const PROMOTE_TIMED_OUT =
  'The promote did not answer. If the row now shows its prep it was promoted; otherwise press Promote again.'

/** The request, aborted after SAVE_TIMEOUT_MS; it then fails as any other
 *  save does (alert, rollback, the queue moves on), even if the request
 *  ignores the abort. */
async function withTimeout<T>(
  send: (signal: AbortSignal) => Promise<T>,
  message = TIMED_OUT
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // rejected first, so the abort's own error can never win the race
      reject(new Error(message))
      controller.abort()
    }, SAVE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([send(controller.signal), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

interface SaveCtx {
  before: HplcSheetRow | undefined
}

/** The leaves a save writes: "hplc_prep.vials.1.vial_mg", "prep_form",
 *  "instrument_id". */
function pathsOf(v: SaveVars): string[] {
  if (v.instrumentId !== undefined) return ['instrument_id']
  const out: string[] = []
  const walk = (x: unknown, at: string) => {
    if (isPlain(x))
      for (const [k, y] of Object.entries(x)) walk(y, `${at}.${k}`)
    else out.push(at)
  }
  if (v.body?.prep_form !== undefined) out.push('prep_form')
  if (v.body?.hplc_prep) walk(v.body.hplc_prep, 'hplc_prep')
  return out
}

function valueAt(row: unknown, path: string): unknown {
  let x = row
  for (const k of path.split('.')) x = isPlain(x) ? x[k] : undefined
  return x
}

/** The leaves the other pending saves for this row write. The saves run one
 *  at a time in call order, so while one settles every other pending save
 *  is a later one, its optimistic value already in the cache. */
function laterPaths(
  qc: QueryClient,
  id: number,
  itemId: number,
  mine: SaveCtx
) {
  return qc
    .getMutationCache()
    .findAll({ mutationKey: SAVE_KEY(id), status: 'pending' })
    .filter(
      m =>
        m.state.context !== mine &&
        (m.state.variables as SaveVars | undefined)?.itemId === itemId
    )
    .flatMap(m => pathsOf(m.state.variables as SaveVars))
}

/**
 * A sheet's saves. Each is optimistic at once; the requests run one at a
 * time in call order (one mutation scope for the sheet, never retried), so
 * the server applies them in the order they were typed. A server row
 * replaces the cached one only when no later save for that row is waiting,
 * and the sheet is read again once the last save on it settles. A failure
 * puts back only the leaves it wrote that no later save has written, and is
 * reported through `onFailure` (a mutate call's own callbacks fire only for
 * the latest call, so a failure before it would go unseen).
 */
function useSheetSave(
  id: number,
  send: (v: SaveVars, signal: AbortSignal) => Promise<unknown>,
  apply: (row: HplcSheetRow, v: SaveVars) => HplcSheetRow,
  onFailure?: HplcSaveFailure
) {
  const qc = useQueryClient()
  const key = HPLC_SHEET_KEY(id)
  const setRow = (itemId: number, fn: (row: HplcSheetRow) => HplcSheetRow) =>
    qc.setQueryData<HplcSheet>(key, sheet =>
      sheet
        ? {
            ...sheet,
            rows: sheet.rows.map(r => (r.item_id === itemId ? fn(r) : r)),
          }
        : sheet
    )
  return useMutation({
    mutationKey: SAVE_KEY(id),
    scope: { id: `hplc-sheet-save-${id}` },
    // a retry could land after a later save; a failure is shown instead
    retry: 0,
    mutationFn: (v: SaveVars) => withTimeout(signal => send(v, signal)),
    onMutate: async (v: SaveVars): Promise<SaveCtx> => {
      await qc.cancelQueries({ queryKey: key })
      const before = qc
        .getQueryData<HplcSheet>(key)
        ?.rows.find(r => r.item_id === v.itemId)
      setRow(v.itemId, row => apply(row, v))
      return { before }
    },
    onError: (err, v, ctx) => {
      onFailure?.(v.what, err instanceof Error ? err.message : 'Save failed')
      const before = ctx?.before
      if (!ctx || !before) return
      const later = new Set(laterPaths(qc, id, v.itemId, ctx))
      const undo = pathsOf(v).filter(p => !later.has(p))
      if (!undo.length) return
      setRow(v.itemId, row => {
        const back = { ...row }
        const prep: Plain = {}
        for (const p of undo) {
          if (p === 'prep_form') {
            back.prep_form = before.prep_form
            back.form = before.form
          } else if (p === 'instrument_id') {
            back.instrument_id = before.instrument_id
            back.instrument_name = before.instrument_name
          } else {
            // hplc_prep.<a>.<b>: the value it held before, or null to remove
            const keys = p.split('.').slice(1)
            let node = prep
            keys.slice(0, -1).forEach(k => {
              node[k] = isPlain(node[k]) ? node[k] : {}
              node = node[k] as Plain
            })
            node[keys[keys.length - 1] as string] = valueAt(before, p) ?? null
          }
        }
        if (Object.keys(prep).length)
          back.hplc_prep = mergeHplcPrep(row.hplc_prep, prep as HplcPrepInputs)
        return back
      })
    },
    onSuccess: (data, v, ctx) => {
      if (v.instrumentId !== undefined || !ctx) return
      if (!laterPaths(qc, id, v.itemId, ctx).length)
        setRow(v.itemId, () => data as HplcSheetRow)
    },
    onSettled: (_d, _e, v) => {
      if (v.instrumentId !== undefined)
        void qc.invalidateQueries({ queryKey: worksheetPageKey(id) })
      // This save still counts as in flight here, so 1 means it is the last.
      if (qc.isMutating({ mutationKey: SAVE_KEY(id) }) > 1) return
      void qc.invalidateQueries({ queryKey: key })
    },
  })
}

/** The row with `body` applied as the server will apply it. A prep_form
 *  sent as null goes back to the sample's own form (bac, else its form's). */
function applied(row: HplcSheetRow, v: SaveVars): HplcSheetRow {
  const body = v.body ?? {}
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

/** One cell's save: a merge patch for its one key. */
export function usePatchHplcRow(id: number, onFailure?: HplcSaveFailure) {
  return useSheetSave(
    id,
    (v, signal) => patchHplcRow(id, v.itemId, v.body ?? {}, { signal }),
    applied,
    onFailure
  )
}

/** True while any save on the sheet is pending. */
export function useHplcSheetSaving(id: number) {
  return useIsMutating({ mutationKey: SAVE_KEY(id) }) > 0
}

/**
 * A row's promote. It runs in the sheet's save scope, never retried, and
 * gives up after SAVE_TIMEOUT_MS, so it can neither overtake a save still
 * queued nor hold one up for long. The sheet is read again whatever the
 * answer (its `row` can be null), unless saves are queued behind it: the
 * last of them reads it then. `readFresh` is the sheet and the prep rules as
 * the server has them now, or null when a save is pending before or after
 * the read (a save cancels the read, which then answers the cached sheet).
 */
export function usePromoteHplcRow(id: number) {
  const qc = useQueryClient()
  const saving = () => qc.isMutating({ mutationKey: SAVE_KEY(id) }) > 0
  const promote = useMutation({
    mutationKey: ['hplc-sheet-promote', id],
    scope: { id: `hplc-sheet-save-${id}` },
    retry: 0,
    mutationFn: (itemId: number) =>
      withTimeout(() => promoteHplcRow(id, itemId), PROMOTE_TIMED_OUT),
    onSettled: () =>
      saving()
        ? undefined
        : qc.invalidateQueries({ queryKey: HPLC_SHEET_KEY(id) }),
  })
  const readFresh = async (): Promise<{
    sheet: HplcSheet
    rules: HplcPrepRule[]
  } | null> => {
    if (saving()) return null
    const [sheet, rules] = await Promise.all([
      qc.fetchQuery({
        queryKey: HPLC_SHEET_KEY(id),
        queryFn: () => getHplcSheet(id),
        staleTime: 0,
      }),
      qc.fetchQuery({
        queryKey: HPLC_PREP_RULES_KEY,
        queryFn: getHplcPrepRules,
        staleTime: 0,
      }),
    ])
    return saving() ? null : { sheet, rules }
  }
  return { promote, readFresh }
}

/** The row's instrument, through the existing item PATCH. */
export function useSetHplcInstrument(id: number, onFailure?: HplcSaveFailure) {
  return useSheetSave(
    id,
    (v, signal) =>
      updateWorksheetItem(
        id,
        v.itemId,
        { instrument_id: v.instrumentId ?? null },
        { signal }
      ),
    (row, v) => ({
      ...row,
      instrument_id: v.instrumentId ?? null,
      instrument_name: null,
    }),
    onFailure
  )
}
