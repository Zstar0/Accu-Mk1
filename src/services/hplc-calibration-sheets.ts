import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CalSheetError,
  getCalSheet,
  listCalSheets,
  saveCalSheet,
  type CalSheet,
  type CalSheetSave,
} from '@/lib/api'
import type { CalInputs, CalReplicateInputs } from '@/lib/hplc-calibration'

/** Every calibration sheet query starts with this key. */
export const CAL_SHEETS_KEY = ['hplc-calibration-sheets'] as const
export const CAL_SHEET_KEY = (id: number) => [...CAL_SHEETS_KEY, id] as const

export function useCalSheets(peptideId?: number) {
  return useQuery({
    queryKey: [...CAL_SHEETS_KEY, 'list', peptideId ?? null],
    queryFn: () => listCalSheets(peptideId),
  })
}

export function useCalSheet(id: number) {
  return useQuery({
    queryKey: CAL_SHEET_KEY(id),
    queryFn: () => getCalSheet(id),
    refetchOnWindowFocus: false,
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
export const RELOADED =
  'Someone else saved this sheet. It has been reloaded, and the changes you had not saved were dropped.'

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
  reloaded: boolean
  /** The local inputs are the server's, nothing is out, no box holds a
   *  refused value. File and Duplicate wait for it. */
  saved: boolean
  /** The version the next save goes on (the last answer's). */
  version: number
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
  reloaded: boolean
  refused: Set<string>
  /** Every body sent that the server has not answered (timed out, or the
   *  network failed), oldest first: one may have landed after all, and the
   *  next 409 tells it from someone else's save. Cleared by a confirmed save. */
  unanswered: CalDraft[]
  seq: number
  mounted: number
  state: CalSaveState
}

// One entry per sheet opened this visit, so leaving and coming back resumes
// the same queue and the same unsaved values (never a second queue on an old
// version). ponytail: never evicted; a few hundred bytes per sheet opened.
const entries = new Map<number, Entry>()
const watchers = new Set<() => void>()

function isSaved(e: Entry) {
  return (
    !e.inFlight &&
    e.error === null &&
    e.refused.size === 0 &&
    sameJson(e.local, e.confirmed)
  )
}

function changed(_id: number, e: Entry) {
  e.state = {
    local: e.local,
    saving: e.inFlight,
    error: e.error,
    reloaded: e.reloaded,
    saved: isSaved(e),
    version: e.version,
  }
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
    reloaded: false,
    refused: new Set(),
    unanswered: [],
    seq: 0,
    mounted: 0,
    state: null as unknown as CalSaveState,
  }
  e.state = {
    local: e.local,
    saving: false,
    error: null,
    reloaded: false,
    saved: true,
    version: e.version,
  }
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
  changed(id, e)
  inTime(signal => saveCalSheet(id, body, { signal }))
    .then(
      res => {
        if (e.seq !== seq) return
        e.version = res.version
        e.confirmed = sent
        e.error = null
        e.unanswered = []
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
          await conflict(id, e, version, msg)
          return
        }
        e.error = msg
        leftWith(e, msg)
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
 *  aborted). */
function inTime<T>(start: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(NO_ANSWER))
      controller.abort()
    }, SAVE_TIMEOUT_MS)
  })
  return Promise.race([start(controller.signal), timeout]).finally(() =>
    clearTimeout(timer)
  )
}

/** A 409: the sheet as the server has it decides. The same version is a
 *  refusal of this save (a filed curve's instrument). A newer version whose
 *  inputs are one of this page's unanswered bodies, or the last confirmed
 *  ones, is this page's own save landing late: nothing was lost, so the
 *  typed values stay and go again on that version. Anything else is
 *  someone else's save: reload and say so. */
async function conflict(
  id: number,
  e: Entry,
  sentVersion: number,
  msg: string
) {
  let fresh: CalSheet
  try {
    fresh = await inTime(() => getCalSheet(id))
  } catch {
    e.error = NO_ANSWER
    leftWith(e, NO_ANSWER)
    return
  }
  e.qc.setQueryData(CAL_SHEET_KEY(id), fresh)
  if (fresh.version <= sentVersion) {
    e.error = msg
    leftWith(e, msg)
    return
  }
  const server = draftOf(fresh)
  e.version = fresh.version
  e.error = null
  const own =
    e.unanswered.some(b => sameJson(b, server)) || sameJson(server, e.confirmed)
  // every unanswered body went on an older version: none can land now
  e.unanswered = []
  if (own) {
    e.confirmed = server
    return
  }
  e.local = server
  e.confirmed = structuredClone(server)
  e.reloaded = true
  toast.error(msg)
  leftWith(e, RELOADED)
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

  // a newer copy from the server replaces the draft only when nothing is unsaved
  useEffect(() => {
    const e = entries.get(id)
    if (!data || !e || data.version <= e.version || !isSaved(e)) return
    e.local = draftOf(data)
    e.confirmed = draftOf(data)
    e.version = data.version
    e.replicate = data.replicate_of_sheet_id !== null
    changed(id, e)
  }, [id, data])

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
        e.reloaded = false
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
