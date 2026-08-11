import { describe, it, expect } from 'vitest'
import type { VialRoleRow, Department } from '@/lib/api'
import {
  ROLE_COLOR_NAMES,
  ROLE_COLOR_BADGE,
  ROLE_COLOR_CHIP,
  ROLE_COLOR_TEXT,
  resolveRoleColor,
  roleShortLabel,
  roleFullLabel,
  roleGlyph,
  roleColorForCode,
} from '@/lib/role-display'

function role(
  overrides: Partial<VialRoleRow> & Pick<VialRoleRow, 'code' | 'label'>
): VialRoleRow {
  return {
    id: overrides.code.length,
    department_id: null,
    boxable: false,
    variance_eligible: false,
    sort_order: 0,
    frozen: false,
    is_system: true,
    color: null,
    short_label: null,
    badge_glyph: null,
    ...overrides,
  }
}

const ROLES: VialRoleRow[] = [
  role({
    code: 'hplc',
    label: 'HPLC',
    department_id: 1,
    color: 'green',
    short_label: 'HPLC',
    badge_glyph: 'H',
  }),
  role({
    code: 'endo',
    label: 'Endotoxin',
    department_id: 2,
    color: 'orange',
    short_label: 'ENDO',
    badge_glyph: 'E',
  }),
  role({
    code: 'ster',
    label: 'Sterility',
    department_id: 2,
    color: 'purple',
    short_label: 'PCR',
    badge_glyph: 'P',
  }),
  role({
    code: 'xtra',
    label: 'Extra',
    department_id: 1,
    color: 'sky',
    short_label: 'XTRA',
    badge_glyph: 'X',
  }),
  role({
    code: 'hm',
    label: 'Heavy Metals',
    department_id: 1,
    color: 'slate',
    short_label: 'HM',
    badge_glyph: 'M',
  }),
  // regression fixture: catalog row with no seeded color/short_label/badge_glyph faces
  role({
    code: 'usp71',
    label: 'USP <71> Sterility',
    department_id: 2,
    color: null,
    short_label: null,
    badge_glyph: null,
  }),
]

const DEPARTMENTS: Department[] = [
  {
    id: 1,
    name: 'Chemistry',
    sort_order: 0,
    color: 'blue',
    is_system: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 2,
    name: 'Microbiology',
    sort_order: 1,
    color: 'violet',
    is_system: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
]

describe('roleShortLabel', () => {
  it('returns the seeded short_label for a known role', () => {
    expect(roleShortLabel('ster', ROLES)).toBe('PCR')
  })

  it('falls back to the uppercased code when short_label is null (usp71 regression)', () => {
    expect(roleShortLabel('usp71', ROLES)).toBe('USP71')
  })

  it('falls back to the uppercased code for an unknown code entirely', () => {
    expect(roleShortLabel('zzghost', ROLES)).toBe('ZZGHOST')
  })
})

describe('roleFullLabel', () => {
  it('returns the seeded label for a known role', () => {
    expect(roleFullLabel('hplc', ROLES)).toBe('HPLC')
  })

  it('falls back to the uppercased code for an unknown code', () => {
    expect(roleFullLabel('zzghost', ROLES)).toBe('ZZGHOST')
  })
})

describe('roleGlyph', () => {
  it('returns the seeded badge_glyph for a known role', () => {
    expect(roleGlyph('hm', ROLES)).toBe('M')
  })

  it('falls back to the first char of the short label when badge_glyph is null', () => {
    expect(roleGlyph('usp71', ROLES)).toBe('U')
  })

  it('always returns exactly one character', () => {
    for (const r of ROLES) {
      expect(roleGlyph(r.code, ROLES)).toHaveLength(1)
    }
  })
})

describe('resolveRoleColor', () => {
  it('uses the role color when present', () => {
    const ster = ROLES.find(r => r.code === 'ster')
    expect(resolveRoleColor(ster, DEPARTMENTS)).toBe('purple')
  })

  it('falls back to the department color when the role color is null', () => {
    const usp71 = ROLES.find(r => r.code === 'usp71')
    expect(resolveRoleColor(usp71, DEPARTMENTS)).toBe('violet')
  })

  it('falls back to zinc when role is undefined', () => {
    expect(resolveRoleColor(undefined)).toBe('zinc')
  })

  it('falls back to zinc when role and department color are both absent', () => {
    const orphan = role({
      code: 'orphan',
      label: 'Orphan',
      department_id: 999,
      color: null,
    })
    expect(resolveRoleColor(orphan, DEPARTMENTS)).toBe('zinc')
  })
})

describe('roleColorForCode', () => {
  it('returns amber for a null/undefined code', () => {
    expect(roleColorForCode(null, ROLES, DEPARTMENTS)).toBe('amber')
    expect(roleColorForCode(undefined, ROLES, DEPARTMENTS)).toBe('amber')
  })

  it('resolves the color for a known code', () => {
    expect(roleColorForCode('ster', ROLES, DEPARTMENTS)).toBe('purple')
  })
})

describe('color vocabulary', () => {
  it('every RoleColorName key exists in all three class maps', () => {
    for (const name of ROLE_COLOR_NAMES) {
      expect(ROLE_COLOR_BADGE[name]).toBeTruthy()
      expect(ROLE_COLOR_CHIP[name]).toBeTruthy()
      expect(ROLE_COLOR_TEXT[name]).toBeTruthy()
    }
  })
})
