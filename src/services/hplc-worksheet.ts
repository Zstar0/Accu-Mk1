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

/** `enabled` false reads nothing (the drawer asks only on an HPLC worksheet). */
export function useHplcSheet(id: number, enabled = true) {
  return useQuery({
    queryKey: HPLC_SHEET_KEY(id),
    queryFn: () => getHplcSheet(id),
    enabled,
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
// (listed, marking its box, blocking its row) when they come back; the
// server failures are also kept in localStorage, so a reload keeps them.
// A refused value is a draft, gone once the page is left: never stored.
const failureLists = new Map<number, HplcFailure[]>()
const loaded = new Set<number>()
const failureWatchers = new Set<() => void>()
const NO_FAILURES: HplcFailure[] = []
let failureSeq = 0

const STORE_PREFIX = 'hplc-sheet-failures:'
const sameFailure = (a: HplcFailure, b: Omit<HplcFailure, 'n'>) =>
  a.text === b.text &&
  !a.refused === !b.refused &&
  a.keys.length === b.keys.length &&
  a.keys.every(k => b.keys.includes(k))

/** The stored server failures of one sheet (empty when none or not what was
 *  written); null when storage cannot be read. A stored failure already in
 *  memory keeps its number, so a Dismiss by number still finds it. */
function readStored(id: number): HplcFailure[] | null {
  let list: unknown
  try {
    const raw = window.localStorage.getItem(STORE_PREFIX + id)
    list = raw ? JSON.parse(raw) : []
  } catch {
    return null
  }
  if (!Array.isArray(list)) return []
  const mine = failureLists.get(id) ?? NO_FAILURES
  const out: HplcFailure[] = []
  for (const x of list)
    if (
      isPlain(x) &&
      typeof x.text === 'string' &&
      Array.isArray(x.keys) &&
      x.keys.every(k => typeof k === 'string')
    ) {
      const f = { text: x.text, keys: x.keys as string[] }
      if (out.some(o => sameFailure(o, f))) continue
      out.push(mine.find(m => sameFailure(m, f)) ?? { ...f, n: ++failureSeq })
    }
  return out
}

/** This sheet's list as storage holds it now (every tab's server
 *  failures) plus this tab's own refused values; this tab's memory when
 *  storage cannot be read. */
function current(id: number): HplcFailure[] {
  const mine = failureLists.get(id) ?? NO_FAILURES
  const stored = readStored(id)
  if (stored === null) return mine
  // a server failure recorded here whose write storage refused (R4): it
  // stays until this tab's own landed save or dismiss
  const pend = unstored.get(id)
  const kept = pend
    ? mine.filter(
        f => !f.refused && pend.has(f.n) && !stored.some(s => s.n === f.n)
      )
    : []
  return [...stored, ...kept, ...mine.filter(f => f.refused)]
}

/** By sheet: the numbers of server failures this tab holds that storage
 *  would not take (a write threw); cleared by the next write that lands. */
const unstored = new Map<number, Set<number>>()

function setMemory(id: number, list: HplcFailure[]) {
  if (list.length) failureLists.set(id, list)
  else failureLists.delete(id)
}

/** Memory takes this list, and the watchers hear of it, only when it
 *  differs (the same entries keep their objects through readStored). */
function sync(id: number, list: HplcFailure[]) {
  const mine = failureLists.get(id) ?? NO_FAILURES
  if (list.length === mine.length && list.every((f, i) => f === mine[i])) return
  setMemory(id, list)
  failureWatchers.forEach(w => w())
}

// Another tab wrote a sheet's failures: take them, so a failure there marks
// and blocks here too, and a dismiss there clears it here.
if (typeof window !== 'undefined')
  window.addEventListener('storage', e => {
    if (e.key !== null && !e.key.startsWith(STORE_PREFIX)) return
    for (const id of loaded) sync(id, current(id))
  })

/** Writes the server failures; false when storage would not take them. */
function writeStored(id: number, list: HplcFailure[]): boolean {
  try {
    const keep = list
      .filter(f => !f.refused)
      .map(f => ({ text: f.text, keys: f.keys }))
    if (keep.length)
      window.localStorage.setItem(STORE_PREFIX + id, JSON.stringify(keep))
    else window.localStorage.removeItem(STORE_PREFIX + id)
    return true
  } catch {
    // storage off or full: the list still works for this visit
    return false
  }
}

/** The failure lists. Every write starts from the list as it is now, in
 *  storage too (R1): a write never drops another tab's server failure, and
 *  a save started on an earlier mount of the page writes into the same
 *  list. A change that changes nothing (`fn` returns its list) writes
 *  nothing. */
export const hplcFailures = {
  get(id: number): HplcFailure[] {
    if (!loaded.has(id)) {
      loaded.add(id)
      setMemory(id, current(id))
    }
    return failureLists.get(id) ?? NO_FAILURES
  },
  update(id: number, fn: (list: HplcFailure[]) => HplcFailure[]) {
    hplcFailures.get(id)
    const base = current(id)
    const next = fn(base)
    if (next === base) {
      // nothing changed here; memory still takes what storage holds
      sync(id, base)
      return
    }
    setMemory(id, next)
    if (writeStored(id, next)) unstored.delete(id)
    else {
      // what this write added or changed, and what was already waiting,
      // stays this tab's until it is stored or this tab removes it
      const was = unstored.get(id) ?? new Set<number>()
      const pend = new Set<number>()
      for (const f of next)
        if (!f.refused && (was.has(f.n) || !base.includes(f))) pend.add(f.n)
      unstored.set(id, pend)
    }
    failureWatchers.forEach(w => w())
  },
  /** A failure. One already listed with the same reason for any of the same
   *  boxes takes this one's boxes too (the new attempt wrote them all), so a
   *  box and reason is never listed twice. */
  add(id: number, f: Omit<HplcFailure, 'n'>) {
    const same = (x: HplcFailure) =>
      x.text === f.text &&
      !x.refused === !f.refused &&
      (x.keys.length === 0
        ? f.keys.length === 0
        : x.keys.some(k => f.keys.includes(k)))
    hplcFailures.update(id, list => {
      const hit = list.find(same)
      if (!hit) return [...list, { ...f, n: ++failureSeq }]
      if (f.keys.every(k => hit.keys.includes(k))) return list
      return list.map(x =>
        x === hit ? { ...x, keys: [...new Set([...x.keys, ...f.keys])] } : x
      )
    })
  },
  /** A save of these keys landed: each failure loses those keys, and goes
   *  once it has none left. A failure holding other keys (a Form change that
   *  also cleared the declared weight) stays for them. A landed save of the
   *  Form supersedes every earlier Form change, so a failure holding the
   *  Form goes whole (R3). */
  landed(id: number, keys: string[]) {
    const form = keys.filter(k => k.endsWith(':prep_form'))
    hplcFailures.update(id, list => {
      if (!list.some(f => f.keys.some(k => keys.includes(k)))) return list
      return list.flatMap(f => {
        if (f.keys.some(k => form.includes(k))) return []
        const left = f.keys.filter(k => !keys.includes(k))
        return left.length === f.keys.length
          ? [f]
          : left.length
            ? [{ ...f, keys: left }]
            : []
      })
    })
  },
  /** The sheet as read: a failure of a row no longer on it, or now
   *  promoted, can never be saved again, so it goes. */
  prune(id: number, rows: { item_id: number; promoted: boolean }[]) {
    const live = new Set(rows.filter(r => !r.promoted).map(r => r.item_id))
    const dead = (f: HplcFailure) =>
      f.keys.length > 0 &&
      f.keys.every(k => !live.has(Number(k.slice(0, k.indexOf(':')))))
    hplcFailures.update(id, list =>
      list.some(dead) ? list.filter(f => !dead(f)) : list
    )
  },
  /** The page left: its refused values go (they were drafts). */
  dropRefused(id: number) {
    hplcFailures.update(id, list =>
      list.some(f => f.refused) ? list.filter(f => !f.refused) : list
    )
  },
  subscribe(watch: () => void) {
    failureWatchers.add(watch)
    return () => void failureWatchers.delete(watch)
  },
  /** Tests: every list emptied, in memory and in storage. */
  reset() {
    failureLists.clear()
    loaded.clear()
    unstored.clear()
    try {
      for (const k of Object.keys(window.localStorage))
        if (k.startsWith(STORE_PREFIX)) window.localStorage.removeItem(k)
    } catch {
      // no storage
    }
    failureWatchers.forEach(w => w())
  },
  /** Tests: forget what is in memory, as a reload does. */
  forgetMemory() {
    failureLists.clear()
    loaded.clear()
    unstored.clear()
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
