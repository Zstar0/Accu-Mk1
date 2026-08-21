import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'

/**
 * S1 guard: hardcoded role display maps are retired BY CLASS. The only
 * legal sources of role label/color are the vial_roles catalog via
 * role-display.ts. This list only shrinks.
 */
const BANNED =
  /\b(ROLE_BADGES|ROLE_PILL|ROLE_LABEL|ROLE_SHORT|ROLE_SHORT_DEFAULTS|ROLE_HEADER_BADGES|ROLE_BADGE_CLASS|ROLE_CHIP_CLASS|ROLE_TEXT_CLASS)\b/
const ALLOW = new Set([
  'src/lib/role-display.ts', // the one legal home (color-name class maps)
  'src/test/role-map-guard.test.ts',
])

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(e)) yield p
  }
}

describe('role display maps stay retired', () => {
  it('no banned role-map identifier outside the allow-list', () => {
    const offenders: string[] = []
    for (const file of walk('src')) {
      const rel = file.split(path.sep).join('/')
      if (ALLOW.has(rel)) continue
      if (BANNED.test(readFileSync(file, 'utf8'))) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})
