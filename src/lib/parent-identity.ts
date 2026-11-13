/**
 * Whether a parent sample page can open the Manage Sub-Samples wizard.
 *
 * Legacy parents are identified by their SENAITE uid. Native-born parents
 * (external_lims_system 'mk1') never have one; the wizard's backend calls
 * resolve them by sample_id (receive-sample takes both), and the SENAITE-only
 * remarks editor already disables itself on an empty uid. Gating on the uid
 * alone greyed the button out on every native sample (P-5014, 2026-09-23).
 */
export function hasParentIdentity(
  data: { sample_id?: string | null; sample_uid?: string | null; external_lims_system?: string | null } | null | undefined,
): boolean {
  if (!data?.sample_id) return false
  return !!data.sample_uid || data.external_lims_system === 'mk1'
}

/**
 * The key the inline field editors post to
 * `/wizard/senaite/samples/{key}/update`.
 *
 * Legacy parents: the SENAITE uid. Native-born parents have none, so the
 * sample_id goes in its place and the backend writes the registry row
 * (`update_senaite_sample_fields` native branch). Sending '' made every
 * Client Lot / Declared Qty edit on a native sample 404 (P-5178, 2026-09-28).
 */
export function fieldEditKey(
  data: { sample_id?: string | null; sample_uid?: string | null; external_lims_system?: string | null } | null | undefined,
): string {
  if (data?.sample_uid) return data.sample_uid
  if (data?.external_lims_system === 'mk1' && data.sample_id) return data.sample_id
  return ''
}
