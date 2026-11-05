import { API_BASE_URL, getBearerHeaders, extractErrorMessage } from '@/lib/api'

/** null = same as the profile's Default, '' (or [] for footnotes) = leave off,
 *  a value = custom. */
export interface ProfileCoaVariantFields {
  coa_section_title: string | null
  coa_basis_note: string | null
  coa_method_text: string | null
  coa_prep_text: string | null
  coa_footnotes: { label: string; text: string }[] | null
}
export interface ProfileCoaVariant extends ProfileCoaVariantFields {
  id: number
  analysis_profile_id: number
  sample_form_id: number
  sample_form_name: string
  active: boolean
  updated_at: string | null
}

// Local fetch wrapper (the api-sample-forms pattern): apiFetch drops the
// server's `detail`, and the 409 for a form that already has a version is the
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

export const listProfileCoaVariants = (profileId: number) =>
  req<ProfileCoaVariant[]>(
    `/analysis-profiles/${profileId}/coa-variants`,
    {},
    'Load COA versions failed'
  )

export const createProfileCoaVariant = (
  profileId: number,
  data: ProfileCoaVariantFields & { sample_form_id: number }
) =>
  req<ProfileCoaVariant>(
    `/analysis-profiles/${profileId}/coa-variants`,
    { method: 'POST', body: JSON.stringify(data) },
    'Add COA version failed'
  )

/** An omitted field stays as it is; an explicit null goes back to the Default. */
export const patchProfileCoaVariant = (
  variantId: number,
  data: Partial<ProfileCoaVariantFields> & { active?: boolean }
) =>
  req<ProfileCoaVariant>(
    `/analysis-profile-coa-variants/${variantId}`,
    { method: 'PATCH', body: JSON.stringify(data) },
    'Save COA version failed'
  )
