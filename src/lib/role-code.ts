/**
 * FE port of backend/catalog/roles.py's suggest_role_code — same algorithm,
 * kept in lockstep by hand (no shared codegen between Python and TS here).
 * Derives a vial_roles.code candidate from a profile key: lowercase, strip
 * anything but [a-z0-9_], truncate to 8 (assignment_role is VARCHAR(8)),
 * uniquify against the caller's existing-codes set with a numeric suffix.
 *
 * Used by AnalysisProfilesPage's fulfillment block to show "Leave blank to
 * auto-create '<suggestion>'" and to fill that suggestion into the payload
 * when the admin saves with an empty role and dim=='role'. The backend's
 * suggest_role_code is the actual authority (this never talks to the
 * server) — this is UX preview only, mirroring FULFILLMENT_ROLE_PATTERN's
 * client-side echo of the backend's regex.
 */
export function suggestRoleCode(key: string, existing: Set<string>): string {
  let base = key.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '')
  if (!base) base = 'role'
  if (!/^[a-z]/.test(base)) base = 'r' + base

  let code = base.slice(0, 8)
  let n = 2
  while (existing.has(code)) {
    const suffix = String(n)
    code = base.slice(0, 8 - suffix.length) + suffix
    n += 1
  }
  return code
}
