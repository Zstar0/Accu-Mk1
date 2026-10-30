import { API_BASE_URL, getBearerHeaders, extractErrorMessage } from '@/lib/api'
import type { SampleFormIconKey } from '@/lib/sample-form-icons'

export type SampleFormRoute = 'injectable' | 'nasal_inhaled' | 'oral'

/** Display order of the routes in pickers. Labels live in en.json
 *  (`preferences.sampleForms.route.<route>`): Injectable, Nasal / inhaled, Oral. */
export const SAMPLE_FORM_ROUTES: readonly SampleFormRoute[] = [
  'injectable',
  'nasal_inhaled',
  'oral',
]

export interface SampleForm {
  id: number
  name: string
  route: SampleFormRoute
  is_default: boolean
  active: boolean
  sort_order: number
  /** null (or a key this build does not know) draws the generic icon */
  icon: string | null
  sample_count: number
}
export interface SampleFormCreate {
  name: string
  route: SampleFormRoute
  sort_order?: number
  icon?: SampleFormIconKey
}
export interface SampleFormUpdate {
  name?: string
  route?: SampleFormRoute
  sort_order?: number
  active?: boolean
  icon?: SampleFormIconKey
  /** The default only ever moves: the server accepts `true`, never `false`. */
  is_default?: true
}
export interface SetSampleFormResult {
  sample_form_id: number
  sample_form_name: string
  sample_form_eligible: boolean
}

// Local fetch wrapper (the api-priorities pattern): apiFetch drops the
// server's `detail`, and "a sample form with that name already exists" is the
// toast the lab needs to see.
async function req<T>(
  path: string,
  init: RequestInit = {},
  fallback = 'Request failed'
): Promise<T> {
  const res = await fetch(`${API_BASE_URL()}${path}`, {
    ...init,
    headers: {
      ...(getBearerHeaders() as Record<string, string>),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!res.ok)
    throw new Error(
      await extractErrorMessage(res, `${fallback}: ${res.status}`)
    )
  return res.json() as Promise<T>
}

export const listSampleForms = (includeInactive = true) =>
  req<SampleForm[]>(
    `/api/sample-forms?include_inactive=${includeInactive}`,
    {},
    'Load sample forms failed'
  )

/** Form id per sample id (a vial id answers with its parent's form), for list
 *  pages that hold only ids. Ids without a form are left out. Max 200. */
export const getSampleFormsOfSamples = (sampleIds: string[]) =>
  req<Record<string, number>>(
    `/api/sample-forms/of-samples?ids=${encodeURIComponent(sampleIds.join(','))}`,
    {},
    'Load sample forms failed'
  )

export const createSampleForm = (body: SampleFormCreate) =>
  req<SampleForm>(
    '/api/sample-forms',
    { method: 'POST', body: JSON.stringify(body) },
    'Create sample form failed'
  )

export const updateSampleForm = (id: number, body: SampleFormUpdate) =>
  req<SampleForm>(
    `/api/sample-forms/${id}`,
    { method: 'PATCH', body: JSON.stringify(body) },
    'Save sample form failed'
  )

/** `sampleId` is the business id (e.g. P-0141), not the registry pk. */
export const setSampleForm = (sampleId: string, sampleFormId: number) =>
  req<SetSampleFormResult>(
    `/api/lims-samples/${encodeURIComponent(sampleId)}/form`,
    { method: 'PATCH', body: JSON.stringify({ sample_form_id: sampleFormId }) },
    'Set sample form failed'
  )
