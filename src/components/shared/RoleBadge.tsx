import { cn } from '@/lib/utils'
import { useVialRoles } from '@/services/vial-roles'
import { useDepartments } from '@/services/departments'
import {
  ROLE_COLOR_BADGE,
  roleColorForCode,
  roleFullLabel,
  roleGlyph,
  roleShortLabel,
  type RoleColorName,
} from '@/lib/role-display'

/**
 * S1 roles-as-data: THE vial-role badge. Label/short/glyph/color come from
 * the vial_roles catalog (react-query cached, 5-min stale) with the
 * department color as fallback — never from a hardcoded map. Unknown or
 * NULL role renders the amber unassigned badge (per-surface text via
 * unassignedLabel), or nothing with hideUnassigned.
 */
export function RoleBadge({
  role,
  form = 'short',
  className,
  unassignedLabel = 'Unassigned',
  hideUnassigned = false,
  makeTitle,
}: {
  role: string | null | undefined
  form?: 'short' | 'full' | 'glyph'
  className?: string
  unassignedLabel?: string
  hideUnassigned?: boolean
  makeTitle?: (label: string) => string
}) {
  const { data: roles } = useVialRoles()
  const { data: departments } = useDepartments()

  // `titleLabel` defaults to the rendered `label` — correct for short/full
  // forms, where the visible text already IS the descriptive text. glyph
  // form is the exception: the visible text is a single character, so the
  // default title (no makeTitle) must resolve the short label instead
  // ("Role: PCR", never "Role: P") — the component owns the roles data,
  // so it's the only place that can do this resolution.
  const render = (label: string, color: RoleColorName, titleLabel: string = label) => (
    <span
      className={cn(
        'inline-flex items-center text-[10px] leading-none px-1.5 py-0.5 rounded border uppercase tracking-wide font-medium',
        ROLE_COLOR_BADGE[color],
        className
      )}
      title={makeTitle ? makeTitle(label) : `Role: ${titleLabel}`}
    >
      {label}
    </span>
  )

  if (!role) {
    return hideUnassigned ? null : render(unassignedLabel, 'amber')
  }

  if (!roles) {
    // Roles catalog hasn't loaded yet — a truthy role is very likely valid,
    // so show the uppercased code in neutral zinc rather than flashing the
    // amber "Unassigned" badge while the query resolves. glyph form only
    // ever shows a single character, so loading shouldn't snap the full
    // short form ("HPLC") in — show its first char instead ("H").
    return render(
      form === 'glyph' ? role.toUpperCase().charAt(0) : roleShortLabel(role, undefined),
      'zinc'
    )
  }

  const known = roles.some(r => r.code === role)
  if (!known) {
    return hideUnassigned ? null : render(unassignedLabel, 'amber')
  }

  const label =
    form === 'full'
      ? roleFullLabel(role, roles)
      : form === 'glyph'
        ? roleGlyph(role, roles)
        : roleShortLabel(role, roles)
  const color = roleColorForCode(role, roles, departments)
  const titleLabel = form === 'glyph' ? roleShortLabel(role, roles) : label
  return render(label, color, titleLabel)
}
