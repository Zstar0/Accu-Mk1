import { describe, it, expect, beforeEach } from 'vitest'
import { getReadSource, setReadSource } from '@/lib/read-source'

describe('read-source', () => {
  beforeEach(() => sessionStorage.clear())

  it('defaults to senaite', () => {
    expect(getReadSource()).toBe('senaite')
  })

  it('persists a set value in sessionStorage', () => {
    setReadSource('mk1')
    expect(getReadSource()).toBe('mk1')
    expect(sessionStorage.getItem('registryReadSource')).toBe('mk1')
  })

  it('ignores a garbage stored value and returns the default', () => {
    sessionStorage.setItem('registryReadSource', 'nonsense')
    expect(getReadSource()).toBe('senaite')
  })
})
