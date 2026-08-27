import { useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getSettings } from '@/lib/api'

export type ReadSource = 'senaite' | 'mk1'
export type PageKey = 'sample_details' | 'samples_list' | 'worksheets_inbox'
export const DEFAULT_READ_SOURCE: ReadSource = 'senaite'
export const READ_SOURCE_SETTING_KEY = 'registry_read_source'

const KEY = 'registryReadSource'
const PAGE_KEYS: readonly PageKey[] = [
  'sample_details',
  'samples_list',
  'worksheets_inbox',
]
const listeners = new Set<() => void>()
const isSource = (v: unknown): v is ReadSource => v === 'senaite' || v === 'mk1'
const isPage = (v: unknown): v is PageKey => PAGE_KEYS.includes(v as PageKey)

/** Read the sessionStorage override map, migrating a legacy bare string. */
function readOverrideMap(): Partial<Record<PageKey, ReadSource>> {
  const raw = sessionStorage.getItem(KEY)
  if (!raw) return {}
  // Legacy: a bare 'senaite'|'mk1' string means a sample_details override.
  if (isSource(raw)) {
    const migrated = { sample_details: raw }
    sessionStorage.setItem(KEY, JSON.stringify(migrated))
    return migrated
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      const out: Partial<Record<PageKey, ReadSource>> = {}
      for (const [k, v] of Object.entries(parsed)) if (isPage(k) && isSource(v)) out[k] = v
      return out
    }
  } catch { /* fall through */ }
  return {}
}

export function getOverride(page: PageKey): ReadSource | null {
  return readOverrideMap()[page] ?? null
}

export function setOverride(page: PageKey, source: ReadSource | null): void {
  const map = readOverrideMap()
  if (source === null) delete map[page]
  else map[page] = source
  sessionStorage.setItem(KEY, JSON.stringify(map))
  listeners.forEach((l) => l())
}

export function parseGlobalReadSource(rawValue: string | undefined | null): Partial<Record<PageKey, ReadSource>> {
  if (!rawValue) return {}
  try {
    const parsed = JSON.parse(rawValue) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Partial<Record<PageKey, ReadSource>> = {}
    for (const [k, v] of Object.entries(parsed)) if (isPage(k) && isSource(v)) out[k] = v
    return out
  } catch { return {} }
}

export function resolveEffective(
  page: PageKey, override: ReadSource | null, globalMap: Partial<Record<PageKey, ReadSource>>,
): ReadSource {
  return override ?? globalMap[page] ?? DEFAULT_READ_SOURCE
}

export function useReadSourceOverride(page: PageKey) {
  const override = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    () => getOverride(page),
    (): ReadSource | null => null,
  )
  return { override, setOverride: (s: ReadSource | null) => setOverride(page, s) }
}

export function useEffectiveReadSource(page: PageKey) {
  const { override, setOverride: set } = useReadSourceOverride(page)
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const raw = settings?.find((s) => s.key === READ_SOURCE_SETTING_KEY)?.value
  const globalMap = parseGlobalReadSource(raw)
  const globalDefault = globalMap[page] ?? DEFAULT_READ_SOURCE
  return { effective: resolveEffective(page, override, globalMap), override, setOverride: set, globalDefault }
}

/** Per-field provenance for the sample-details page. Returns undefined
 *  outside mk1 read mode (glyphs render nothing — SENAITE mode is untouched).
 *  In mk1 mode, an ABSENT key means SENAITE-owned: the backend deliberately
 *  keeps workflow state (review_state) out of field_sources because the
 *  registry must never shadow it. */
export function detailsFieldSource(
  readSource: string | undefined,
  fieldSources: Record<string, 'mk1' | 'senaite'> | undefined,
  field: string,
): ReadSource | undefined {
  if (readSource !== 'mk1') return undefined
  return (fieldSources ?? {})[field] ?? 'senaite'
}

/** Data Source map key for COA generation sourcing. Deliberately NOT a
 *  PageKey: the BACKEND reads this key at wire-document assembly time
 *  (backend/coa/source_setting.py), so per-session page overrides must
 *  never apply — what the badge shows must be what the backend does. */
export const COA_SOURCE_KEY = 'coa_generation'

export function parseCoaGenerationSource(rawValue: string | undefined | null): ReadSource {
  if (!rawValue) return DEFAULT_READ_SOURCE
  try {
    const parsed = JSON.parse(rawValue) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const v = (parsed as Record<string, unknown>)[COA_SOURCE_KEY]
      if (isSource(v)) return v
    }
  } catch { /* fall through */ }
  return DEFAULT_READ_SOURCE
}

export function coaSourceLabel(source: ReadSource): string {
  return source === 'mk1' ? 'Accu-Mk1' : 'SENAITE'
}

/** Badge label for the COA Actions menu. Sub-sample (-SXX) COA generation is
 *  a pre-existing independent path the backend keeps SENAITE-sourced
 *  regardless of the toggle (the is_sub gate ahead of wire-document assembly
 *  in backend/main.py) — so on sub-sample pages the badge says SENAITE, not
 *  what the toggle promises for parents. */
export function coaSourceBadgeLabel(source: ReadSource, isParent: boolean): string {
  return coaSourceLabel(isParent ? source : 'senaite')
}

export function useCoaGenerationSource(): ReadSource {
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const raw = settings?.find((s) => s.key === READ_SOURCE_SETTING_KEY)?.value
  return parseCoaGenerationSource(raw)
}
