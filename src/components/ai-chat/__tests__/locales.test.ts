import { describe, expect, it } from 'vitest'
import en from '../../../../locales/en.json'
import fr from '../../../../locales/fr.json'
import ar from '../../../../locales/ar.json'

// The AI chat and ACP Providers copy is translated in full; a key added to en
// alone would fall back to English without anyone noticing.
const ours = (k: string) =>
  k.startsWith('aiChat.') || k.startsWith('preferences.acpProviders.')
const keys = (l: Record<string, string>) => Object.keys(l).filter(ours)
// Arabic adds plural forms English does not have (`_zero`, `_two`, ...).
const base = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, '')

describe('AI chat locales', () => {
  it.each([
    ['fr', fr],
    ['ar', ar],
  ])('%s has every English key, and nothing English does not', (_, l) => {
    const theirs = new Set(keys(l))
    expect(keys(en).filter(k => !theirs.has(k))).toEqual([])
    const enBases = new Set(keys(en).map(base))
    expect(keys(l).filter(k => !enBases.has(base(k)))).toEqual([])
  })
})
