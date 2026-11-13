import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CalSheetError,
  duplicateCalSheet,
  fileCalSheet,
  getCalSheet,
  listCalSheets,
  saveCalSheet,
  type CalFileResult,
  type CalSheet,
  type CalSheetSave,
} from '@/lib/api'
import type { CalInputs, CalReplicateInputs } from '@/lib/hplc-calibration'
import { withTimeout } from '@/services/hplc-worksheet'

/** Every calibration sheet query starts with this key. */
export const CAL_SHEETS_KEY = ['hplc-calibration-sheets'] as const
export const CAL_SHEET_KEY = (id: number) => [...CAL_SHEETS_KEY, id] as const

/** The server's page size for the list (its default and its maximum). */
export const CAL_LIST_PAGE = 100

/** The list, a page of CAL_LIST_PAGE at a time (M5): a full page means
 *  there may be more. */
export function useCalSheets(peptideId?: number) {
  return useInfiniteQuery({
    queryKey: [...CAL_SHEETS_KEY, 'list', peptideId ?? null],
    queryFn: ({ pageParam }) =>
      listCalSheets(peptideId, { limit: CAL_LIST_PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, all) =>
      last.length === CAL_LIST_PAGE ? all.length * CAL_LIST_PAGE : undefined,
    // every visit reads the server: another bench's new sheets show (M5)
    staleTime: 0,
  })
}

export function useCalSheet(id: number) {
  return useQuery({
    queryKey: CAL_SHEET_KEY(id),
    queryFn: () => getCalSheet(id),
    refetchOnWindowFocus: false,
    // every open reads the server, never the app's 5 minute copy: an
    // injection reopened after its original was re-filed shows the new
    // preparation (final review I2). A newer copy goes through the hook's
    // own-or-foreign match; the same version only moves `latest`.
    staleTime: 0,
  })
}

/** What the page edits and saves: the sheet's own fields. */
export interface CalDraft {
  peptide_id: number | null
  instrument_id: number | null
  inputs: CalInputs | CalReplicateInputs
}

/** How long a save may go unanswered before it counts as failed. */
export const SAVE_TIMEOUT_MS = 15_000
export const NO_ANSWER = 'the server did not answer'
/** While a sent save is unaccounted for, the sheet is read again this often. */
export const CHECK_EVERY_MS = 5_000
/** A save still unaccounted for this long after it was sent, with the
 *  server's version unmoved, is taken as lost. */
export const LOST_AFTER_MS = 60_000
export const CHECKING = 'Checking that the last save went through...'
export const RELOADED =
  'Someone else saved this sheet. It has been reloaded, and the changes you had not saved were dropped.'
/** The same, when this page had nothing unsaved to drop. */
export const RELOADED_NOTHING_LOST =
  'Someone else saved this sheet. It has been reloaded: check the values before filing.'

/** What no answer means for New, wherever a sheet is started (M3). */
export const NEW_NO_ANSWER =
  'New calibration worksheet: the server did not answer, so it may have been made. Look under Calibration worksheets before trying again.'

/** The server's sentence, or what no answer means for that action: a
 *  timeout, a network failure, or a 5xx (a gateway may have timed out on a
 *  request that went through) is no answer (M3). */
export function refusalOf(e: unknown, noAnswer: string): string {
  return e instanceof CalSheetError && e.status < 500 ? e.message : noAnswer
}

/** Equal as stored: key order does not count, and a missing key, undefined
 *  and null are all "empty" (the server fills every key, with null). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b || (a == null && b == null)) return true
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object'
  )
    return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)])
  for (const k of keys) if (!sameJson(ra[k], rb[k])) return false
  return true
}

const draftOf = (s: CalSheet): CalDraft => ({
  peptide_id: s.peptide_id,
  instrument_id: s.instrument_id,
  inputs: structuredClone(s.inputs),
})

/** What the page reads; a new object on every change. */
export interface CalSaveState {
  local: CalDraft
  saving: boolean
  error: string | null
  /** The reload line's sentence, until dismissed (null: none). */
  reloaded: string | null
  /** A refusal whose compound or instrument was put back, until dismissed
   *  or replaced (fix round 2; null: none). */
  said: string | null
  /** The local inputs are the server's, nothing is out, no sent save is
   *  unaccounted for, no box holds a refused value. File and Duplicate wait
   *  for it. */
  saved: boolean
  /** The version the next save goes on (the last answer's). */
  version: number
  /** The boxes holding a value they refused ("part.key" or "level.i.key"). */
  refused: string[]
  /** A save went out and was never answered, and nothing is out now: the
   *  sheet is read again to see whether it landed (H1). */
  checking: boolean
  /** The newest copy of the sheet this page has seen (a save's answer, a
   *  re-read, a filing): a lagging query copy never replaces it. */
  latest: CalSheet
}

interface Entry {
  qc: QueryClient
  name: string
  replicate: boolean
  local: CalDraft
  confirmed: CalDraft
  version: number
  inFlight: boolean
  error: string | null
  reloaded: string | null
  said: string | null
  refused: Set<string>
  /** Every body sent that the server has not answered (timed out, or the
   *  network failed), oldest first: one may have landed after all, and the
   *  next newer copy of the sheet tells it from someone else's save. Cleared
   *  when the version moves, or as lost after LOST_AFTER_MS. */
  unanswered: CalDraft[]
  /** Bodies cleared from `unanswered` as lost after LOST_AFTER_MS: one may
   *  still land, so only the own-or-foreign match reads them (I1). Emptied
   *  when the version moves. No effect on saved or checking. */
  lost: CalDraft[]
  /** A checking re-read is out: the next tick waits (I2). */
  reading: boolean
  /** See CalSaveState.latest. */
  latest: CalSheet
  seq: number
  mounted: number
  state: CalSaveState
}

// One entry per sheet opened this visit, so leaving and coming back resumes
// the same queue and the same unsaved values (never a second queue on an old
// version). ponytail: never evicted; a few hundred bytes per sheet opened.
const entries = new Map<number, Entry>()
const watchers = new Set<() => void>()
/** When each body went out (Date.now()), for LOST_AFTER_MS. */
const sentAt = new WeakMap<CalDraft, number>()

function isSaved(e: Entry) {
  return (
    !e.inFlight &&
    e.error === null &&
    e.unanswered.length === 0 &&
    e.refused.size === 0 &&
    sameJson(e.local, e.confirmed)
  )
}

function stateOf(e: Entry): CalSaveState {
  return {
    local: e.local,
    saving: e.inFlight,
    error: e.error,
    reloaded: e.reloaded,
    said: e.said,
    saved: isSaved(e),
    version: e.version,
    refused: [...e.refused],
    checking: !e.inFlight && e.unanswered.length > 0,
    latest: e.latest,
  }
}

function changed(_id: number, e: Entry) {
  e.state = stateOf(e)
  watchers.forEach(w => w())
}

function newEntry(qc: QueryClient, s: CalSheet): Entry {
  const e: Entry = {
    qc,
    name: s.curve_name ?? s.proposed_name,
    replicate: s.replicate_of_sheet_id !== null,
    local: draftOf(s),
    confirmed: draftOf(s),
    version: s.version,
    inFlight: false,
    error: null,
    reloaded: null,
    said: null,
    refused: new Set(),
    unanswered: [],
    lost: [],
    reading: false,
    latest: s,
    seq: 0,
    mounted: 0,
    state: null as unknown as CalSaveState,
  }
  e.state = stateOf(e) // in render: never notify here
  return e
}

function leftWith(e: Entry, why: string) {
  if (e.mounted === 0)
    toast.error(
      `Calibration sheet ${e.name}: your last changes were not saved. ${why}`
    )
}

/** Sends the local draft when it differs from the confirmed one, or when a
 *  failure is showing (a body that may have landed must be overwritten):
 *  one request at a time, the version the last answer gave. */
function pump(id: number) {
  const e = entries.get(id)
  if (!e || e.inFlight) return
  if (e.error === null && sameJson(e.local, e.confirmed)) return
  const sent = structuredClone(e.local)
  const version = e.version
  const body: CalSheetSave = e.replicate
    ? { version, instrument_id: sent.instrument_id, inputs: sent.inputs }
    : {
        version,
        peptide_id: sent.peptide_id,
        instrument_id: sent.instrument_id,
        inputs: sent.inputs,
      }
  const seq = ++e.seq
  e.inFlight = true
  e.unanswered.push(sent)
  sentAt.set(sent, Date.now())
  changed(id, e)
  inTime(signal => saveCalSheet(id, body, { signal }))
    .then(
      res => {
        if (e.seq !== seq) return
        // A newer version: every body on the list went on an older one and
        // can no longer land. The same version (a save that changed nothing)
        // says nothing about bodies still in the air on it: only this one is
        // accounted for (H1).
        e.unanswered =
          res.version > version ? [] : e.unanswered.filter(b => b !== sent)
        if (res.version > version) e.lost = []
        e.latest = res
        e.version = res.version
        e.confirmed = sent
        e.error = null
        e.name = res.curve_name ?? res.proposed_name
        e.qc.setQueryData(CAL_SHEET_KEY(id), res)
        void e.qc.invalidateQueries({
          queryKey: [...CAL_SHEETS_KEY, 'list'],
        })
      },
      async (err: unknown) => {
        if (e.seq !== seq) return
        // only a refusal is the server's answer; anything else (a timeout,
        // "Failed to fetch") may have landed, and reads as no answer
        const refused = err instanceof CalSheetError
        const msg = refused ? err.message : NO_ANSWER
        // a 4xx was not stored; a 5xx (a gateway timing out) may have been
        if (refused && err.status < 500)
          e.unanswered = e.unanswered.filter(b => b !== sent)
        if (refused && err.status === 409) {
          await conflict(id, e, version, msg, sent)
          return
        }
        // a plain 4xx is about a picker only when the inputs are the stored
        // ones; otherwise the inputs may be what was refused (I-N1)
        if (
          refused &&
          err.status < 500 &&
          sameJson(sent.inputs, e.confirmed.inputs)
        )
          refuse(e, sent, msg)
        else {
          e.error = msg
          leftWith(e, msg)
        }
      }
    )
    .finally(() => {
      if (e.seq !== seq) return
      e.inFlight = false
      changed(id, e)
      // an edit made while this one was out goes now, unless this one failed
      if (e.error === null) pump(id)
    })
}

/** A request that counts as unanswered after SAVE_TIMEOUT_MS (and is then
 *  aborted): the prep sheet's own time limit (M6). */
export const inTime = <T>(start: (signal: AbortSignal) => Promise<T>) =>
  withTimeout(start, NO_ANSWER)

/** A 409: the sheet as the server has it decides. The same version is a
 *  refusal of this save (a filed curve's instrument). A newer version goes
 *  through `settle`. */
async function conflict(
  id: number,
  e: Entry,
  sentVersion: number,
  msg: string,
  sent: CalDraft
) {
  let fresh: CalSheet
  try {
    fresh = await inTime(() => getCalSheet(id))
  } catch {
    e.error = NO_ANSWER
    leftWith(e, NO_ANSWER)
    return
  }
  if (fresh.version <= sentVersion) {
    refuse(e, sent, msg)
    if (fresh.version >= e.latest.version) e.latest = fresh
  } else settle(e, fresh, msg)
  e.qc.setQueryData(CAL_SHEET_KEY(id), fresh)
}

/** A refusal (4xx) of a body. When that body changed the compound or the
 *  instrument (a picker) and the picker still shows it, the picker goes back
 *  to the stored value, the rest of the draft is sent on its own, and the
 *  sentence stays as `said` until dismissed (fix round 2): a picker value
 *  the server refuses can never be saved. Anything else (a typed box) stays
 *  on the page with the Not saved line and Retry. */
function refuse(e: Entry, sent: CalDraft, msg: string) {
  const back = (['peptide_id', 'instrument_id'] as const).filter(
    k => sent[k] !== e.confirmed[k] && e.local[k] === sent[k]
  )
  leftWith(e, msg)
  if (back.length === 0) {
    e.error = msg
    return
  }
  const local = { ...e.local }
  for (const k of back) local[k] = e.confirmed[k]
  e.local = local
  e.said = msg
  e.error = null // pump sends what is left once this one is done
}

/** A copy of the sheet newer than the version held, by any route (a 409's
 *  re-read, a refetch, the checking re-read). Equal to one of this page's
 *  unanswered bodies, or to the last confirmed inputs, it is this page's own
 *  save landing late: nothing was lost, so its version is taken and the typed
 *  values stay (pump sends them again if they differ). Anything else is
 *  someone else's save: reload and say so. Every unanswered body went on an
 *  older version, so none can land now. */
function settle(e: Entry, fresh: CalSheet, said: string) {
  const server = draftOf(fresh)
  // a body cleared as lost can still land (I1); a copy equal to what is on
  // screen differs from nothing this page holds
  const own =
    [...e.unanswered, ...e.lost].some(b => sameJson(b, server)) ||
    sameJson(server, e.confirmed) ||
    sameJson(server, e.local)
  // anything typed, refused or in the air that the reload throws away
  const lost =
    e.inFlight ||
    e.unanswered.length > 0 ||
    e.refused.size > 0 ||
    !sameJson(e.local, e.confirmed)
  e.version = fresh.version
  e.replicate = fresh.replicate_of_sheet_id !== null
  e.error = null
  e.unanswered = []
  e.lost = []
  e.latest = fresh
  if (own) {
    e.confirmed = server
    return
  }
  e.local = server
  e.confirmed = structuredClone(server)
  e.reloaded = lost ? RELOADED : RELOADED_NOTHING_LOST
  // the page closed: leftWith's toast alone says it, once (M-N2)
  if (e.mounted > 0 || !lost) toast.error(lost ? said : RELOADED_NOTHING_LOST)
  if (lost) leftWith(e, RELOADED)
}

/** While a sent save is unaccounted for and nothing is out: read the sheet
 *  again. A moved version is settled; an unmoved one, LOST_AFTER_MS after the
 *  last of those bodies went out, means they were lost (H1). */
async function check(id: number) {
  const e = entries.get(id)
  if (!e || e.inFlight || e.reading || e.unanswered.length === 0) return
  // the time the question was asked, not answered: a read that began before
  // the limit never clears the list (I2)
  const asked = Date.now()
  let fresh: CalSheet
  e.reading = true
  try {
    fresh = await inTime(() => getCalSheet(id))
  } catch {
    return // no answer proves nothing; the next re-read tries again
  } finally {
    e.reading = false
  }
  if (entries.get(id) !== e || e.inFlight || e.unanswered.length === 0) return
  if (fresh.version > e.version) {
    settle(e, fresh, RELOADED)
    e.qc.setQueryData(CAL_SHEET_KEY(id), fresh)
  } else {
    const last = Math.max(...e.unanswered.map(b => sentAt.get(b) ?? 0))
    if (asked - last < LOST_AFTER_MS) return
    e.lost.push(...e.unanswered)
    e.unanswered = []
    // nothing typed is waiting: the "did not answer" line has nothing to retry
    if (e.error === NO_ANSWER && sameJson(e.local, e.confirmed)) e.error = null
  }
  changed(id, e)
  if (e.error === null) pump(id)
}
function subscribe(w: () => void) {
  watchers.add(w)
  return () => void watchers.delete(w)
}

/** Tests: forget every sheet. */
export function resetCalSaves() {
  entries.clear()
}

/**
 * A sheet's editing and saving (task-6-addendum "Saving"): what is on screen
 * is the local draft; every change is saved whole, with the version the last
 * answer gave, one request at a time; a failure stays on the page until a
 * save lands; a 409 reloads only when someone else saved. Leaving the page
 * with unsaved changes sends them once more, and says so if that fails.
 */
export function useSaveCalSheet(id: number) {
  const qc = useQueryClient()
  // Coming back to a sheet whose entry holds nothing unsaved: drop it, so the
  // page waits for the server's copy instead of showing the one kept.
  const [dropped] = useState(() => {
    const e = entries.get(id)
    if (!e || e.mounted > 0 || !isSaved(e)) return false
    entries.delete(id)
    return true
  })
  const { data, error: loadError, isFetching } = useCalSheet(id)
  // created on first sight without notifying (render must not set others'
  // state); after a drop, from the server's answer, not the cached copy
  if (data && !(dropped && isFetching) && !entries.has(id) && data.id === id)
    entries.set(id, newEntry(qc, data))
  const state = useSyncExternalStore(
    subscribe,
    () => entries.get(id)?.state ?? null
  )
  const ready = state !== null

  // A newer copy from the server goes through the same own-or-foreign match
  // as a 409 (H1): never taken blindly, and someone else's save is always
  // announced, even when this page had nothing unsaved. Never while a save
  // is out: its answer or its 409 decides, and this runs again once it is back.
  const saving = state?.saving ?? false
  useEffect(() => {
    const e = entries.get(id)
    if (!data || !e) return
    // the same version or newer is the freshest copy (a filing keeps the
    // version); an older one is a lagging refetch
    if (data !== e.latest && data.version >= e.latest.version) {
      e.latest = data
      changed(id, e)
    }
    if (e.inFlight || data.version <= e.version) return
    settle(e, data, RELOADED)

    changed(id, e)
    if (e.error === null) pump(id)
  }, [id, data, saving])

  // the re-reads while a sent save is unaccounted for; stopped on unmount
  // and while a save is out (checking is false then)
  const checking = state?.checking ?? false
  useEffect(() => {
    if (!checking) return
    const timer = setInterval(() => void check(id), CHECK_EVERY_MS)
    return () => clearInterval(timer)
  }, [id, checking])

  useEffect(() => {
    const e = entries.get(id)
    if (e) {
      e.mounted++
      e.qc = qc
    }
    return () => {
      const now = entries.get(id)
      if (!now) return
      now.mounted = Math.max(0, now.mounted - 1)
      if (now.mounted > 0) return
      now.refused.clear()
      changed(id, now)
      // one last save; a failure of it is a toast naming the sheet
      pump(id)
    }
    // ready: the entry exists only once the server's sheet has been read
  }, [id, ready, qc])

  const saved = state?.saved ?? true
  useEffect(() => {
    if (saved) return
    const ask = (ev: BeforeUnloadEvent) => {
      ev.preventDefault()
      ev.returnValue = ''
    }
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [saved])

  const withEntry = (fn: (e: Entry) => void) => {
    const e = entries.get(id)
    if (!e) return
    fn(e)
    changed(id, e)
  }
  return {
    sheet: data,
    /** The sheet could not be read (404, network). */
    loadError,
    state,
    saved,
    /** A change to the draft; saved in the background. */
    edit: (fn: (d: CalDraft) => CalDraft) => {
      withEntry(e => {
        e.local = fn(e.local)
      })
      pump(id)
    },
    /** Send the current draft again after a failure. */
    // the failure line stays until a save lands (rule 3)
    retry: () => pump(id),
    dismissReloaded: () =>
      withEntry(e => {
        e.reloaded = null
      }),
    dismissSaid: () =>
      withEntry(e => {
        e.said = null
      }),
    /** A box holds (`on`) or no longer holds a value it refused. */
    setRefused: (key: string, on: boolean) => {
      const e = entries.get(id)
      if (!e || e.refused.has(key) === on) return
      if (on) e.refused.add(key)
      else e.refused.delete(key)
      changed(id, e)
    },
  }
}

/**
 * File curve (POST .../file, Task 5). The filed sheet goes into the cache as
 * it is: filing is not a save, so its version is the one the hook holds and
 * the hook keeps its draft (task-6-report "For Task 7"). If a save landed
 * while the filing ran, the cache already holds a newer sheet: read it again
 * instead of putting an older one back. A refusal or no answer also reads the
 * sheet again: a 409 says "It has been reloaded", and a filing that landed
 * without an answer then shows as filed. Unanswered after SAVE_TIMEOUT_MS
 * counts as no answer (M3).
 */
export function useFileCalSheet(id: number) {
  const qc = useQueryClient()
  const reread = () =>
    void qc.invalidateQueries({ queryKey: CAL_SHEET_KEY(id), exact: true })
  return async (version: number): Promise<CalFileResult> => {
    let res: CalFileResult
    try {
      res = await inTime(() => fileCalSheet(id, version))
    } catch (e) {
      reread()
      throw e
    }
    const held = qc.getQueryData<CalSheet>(CAL_SHEET_KEY(id))
    if (held && held.version > res.sheet.version) reread()
    else qc.setQueryData(CAL_SHEET_KEY(id), res.sheet)
    // every other sheet and the list: an original's File re-files its
    // injections (I2). Not this sheet's own key: it was just set from the
    // answer (or is being read again), and a second read adds nothing.
    void qc.invalidateQueries({
      queryKey: CAL_SHEETS_KEY,
      predicate: q => q.queryKey[1] !== id,
    })
    return res
  }
}

/** Duplicate for another injection: the copy goes into the cache, ready to
 *  open. Unanswered after SAVE_TIMEOUT_MS counts as no answer (M3). */
export function useDuplicateCalSheet() {
  const qc = useQueryClient()
  return async (id: number): Promise<CalSheet> => {
    const copy = await inTime(() => duplicateCalSheet(id))
    qc.setQueryData(CAL_SHEET_KEY(copy.id), copy)
    void qc.invalidateQueries({ queryKey: [...CAL_SHEETS_KEY, 'list'] })
    return copy
  }
}
