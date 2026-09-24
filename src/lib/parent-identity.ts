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
