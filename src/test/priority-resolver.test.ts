import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolvePriority } from '@/lib/priority-resolver'

const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../backend/tests/fixtures/priority_cases.json'),
    'utf8'
  )
)

describe('resolvePriority mirrors backend/priority/resolver.py', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const eff = resolvePriority(c.explicit, fixture.priorities)
      expect([eff.key, eff.rank, eff.source_level]).toEqual([
        c.expect.key,
        c.expect.rank,
        c.expect.source_level,
      ])
    })
  }
  it('throws without a default', () => {
    expect(() =>
      resolvePriority({}, [
        { key: 'high', rank: 10, is_active: true, is_default: false },
      ])
    ).toThrow()
  })
})
