import { describe, it, expect } from 'vitest'
import { isThrottleError } from '../SharePointBrowser'

describe('isThrottleError', () => {
  it('matches 429 and throttle-shaped messages', () => {
    expect(isThrottleError('SharePoint browse failed: 429 — Too Many Requests')).toBe(true)
    expect(isThrottleError('request was throttled')).toBe(true)
    expect(isThrottleError('rate limit exceeded')).toBe(true)
    expect(isThrottleError('Retry-After: 30')).toBe(true)
  })
  it('does not match ordinary errors', () => {
    expect(isThrottleError('SharePoint browse failed: 404 — Not Found')).toBe(false)
    expect(isThrottleError('Failed to load folder')).toBe(false)
  })
})
