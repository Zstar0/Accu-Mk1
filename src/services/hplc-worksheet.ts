import { useSyncExternalStore } from 'react'
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

/** One stored value of one row, as a key: "<item id>:<path>", the path as a
 *  save writes it ("hplc_prep.vials.1.vial_mg", "prep_form",
 *  "instrument_id"). A box's failed saves are found by it. */
export const boxKey = (itemId: number, path: string) => `${itemId}:${path}`

/** True when the key is one of this row's. */
export const isRowKey = (key: string, itemId: number) =>
  key.startsWith(`${itemId}:`)

/** One line of a sheet's failure list. `refused`: a value a box refused
 *  before sending; the box itself clears it (Escape, or a value it takes).
 *  A save that did not land goes only when that box saves or the line is
 *  dismissed. */
export interface HplcFailure {
  n: number
  /** "<sample id>, <column>: <reason>" */
  text: string
  /** The boxKeys of the values it wrote (empty: none known). */
  keys: string[]
  refused?: boolean
}

// Each sheet's undismissed failures, by worksheet id. Module state, so a
// failure that answers after the technician left the page is still there
// (listed, marking its box, blocking its row) when they come back.
const failureLists = new Map<number, HplcFailure[]>()
const failureWatchers = new Set<() => void>()
const NO_FAILURES: HplcFailure[] = []
let failureSeq = 0

/** The failure lists. Every write reads the list as it is now, so a save
 *  started on an earlier mount of the page writes into the same list. */
export const hplcFailures = {
  get: (id: number): HplcFailure[] => failureLists.get(id) ?? NO_FAILURES,
  update(id: number, fn: (list: HplcFailure[]) => HplcFailure[]) {
    const next = fn(hplcFailures.get(id))
    if (next.length) failureLists.set(id, next)
    else failureLists.delete(id)
    failureWatchers.forEach(w => w())
  },
  add(id: number, f: Omit<HplcFailure, 'n'>) {
    hplcFailures.update(id, list => [...list, { ...f, n: ++failureSeq }])
  },
  subscribe(watch: () => void) {
    failureWatchers.add(watch)
    return () => void failureWatchers.delete(watch)
  },
  /** Tests: every list emptied. */
  reset() {
    failureLists.clear()
    failureWatchers.forEach(w => w())
  },
}

/** One sheet's failure list, re-rendering as it changes. */
export function useHplcFailures(id: number): HplcFailure[] {
  return useSyncExternalStore(hplcFailures.subscribe, () =>
    hplcFailures.get(id)
  )
}

/** A save that did not land: which box ("<sample id>, <column>"), why, and
 *  the keys of the values it wrote (boxKey). */
export type HplcSaveFailure = (
  what: string,
  reason: string,
  keys: string[]
) => void

/** A save that landed: the keys of the values it wrote. */
export type HplcSaveLanded = (keys: string[]) => void

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
  onFailure?: HplcSaveFailure,
  onLanded?: HplcSaveLanded
) {
  const keysOf = (v: SaveVars) => pathsOf(v).map(p => boxKey(v.itemId, p))
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
      onFailure?.(
        v.what,
        err instanceof Error ? err.message : 'Save failed',
        keysOf(v)
      )
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
      onLanded?.(keysOf(v))
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
export function usePatchHplcRow(
  id: number,
  onFailure?: HplcSaveFailure,
  onLanded?: HplcSaveLanded
) {
  return useSheetSave(
    id,
    (v, signal) => patchHplcRow(id, v.itemId, v.body ?? {}, { signal }),
    applied,
    onFailure,
    onLanded
  )
}

/** True while any save on the sheet is pending. */
export function useHplcSheetSaving(id: number) {
  return useIsMutating({ mutationKey: SAVE_KEY(id) }) > 0
}

/** A press's read-again of the prep rules failed (not the sheet's). */
export class HplcRulesReadError extends Error {}

/**
 * A row's promote. It runs in the sheet's save scope, never retried, and
 * gives up after SAVE_TIMEOUT_MS, so it can neither overtake a save still
 * queued nor hold one up for long. The sheet is read again whatever the
 * answer (its `row` can be null), unless saves are queued behind it: the
 * last of them reads it then. `readFresh` is the sheet and the prep rules as
 * the server has them now, or null when a save is pending before or after
 * the read, or was sent during it (a save cancels the read, which then
 * answers the cached sheet).
 */
export function usePromoteHplcRow(
  id: number,
  /** Why this row must not be promoted now (a save of it did not land), read
   *  when the request is about to go, after every save queued before it. */
  blocked?: (itemId: number) => string | null
) {
  const qc = useQueryClient()
  const saving = () => qc.isMutating({ mutationKey: SAVE_KEY(id) }) > 0
  const promote = useMutation({
    mutationKey: ['hplc-sheet-promote', id],
    scope: { id: `hplc-sheet-save-${id}` },
    retry: 0,
    mutationFn: (itemId: number) => {
      const why = blocked?.(itemId)
      if (why) return Promise.reject(new Error(why))
      // The request can still land after the 15 second cut: when it does,
      // the sheet is read again (onSettled read it at the cut), so a row it
      // promoted shows final. Before the cut, onSettled does the reading.
      let cut = false
      const readAgain = () => {
        if (cut && !saving())
          void qc.invalidateQueries({ queryKey: HPLC_SHEET_KEY(id) })
      }
      return withTimeout(() => {
        const sent = promoteHplcRow(id, itemId)
        sent.then(readAgain, readAgain)
        return sent
      }, PROMOTE_TIMED_OUT).catch((e: unknown) => {
        if (e instanceof Error && e.message === PROMOTE_TIMED_OUT) cut = true
        throw e
      })
    },
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
    // a save sent after the press began, even one that has already landed:
    // what was read may be from before it
    let sentSince = false
    const saveKey = JSON.stringify(SAVE_KEY(id))
    const stop = qc.getMutationCache().subscribe(e => {
      if (
        e.type === 'added' &&
        JSON.stringify(e.mutation.options.mutationKey) === saveKey
      )
        sentSince = true
    })
    try {
      const [sheet, rules] = await Promise.all([
        qc.fetchQuery({
          queryKey: HPLC_SHEET_KEY(id),
          queryFn: () => getHplcSheet(id),
          staleTime: 0,
        }),
        qc
          .fetchQuery({
            queryKey: HPLC_PREP_RULES_KEY,
            queryFn: getHplcPrepRules,
            staleTime: 0,
          })
          .catch((e: unknown) => {
            // the press says which read failed
            throw new HplcRulesReadError(
              e instanceof Error ? e.message : 'the read failed'
            )
          }),
      ])
      return saving() || sentSince ? null : { sheet, rules }
    } finally {
      stop()
    }
  }
  return { promote, readFresh }
}

/** The row's instrument, through the existing item PATCH. */
export function useSetHplcInstrument(
  id: number,
  onFailure?: HplcSaveFailure,
  onLanded?: HplcSaveLanded
) {
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
    onFailure,
    onLanded
  )
}
