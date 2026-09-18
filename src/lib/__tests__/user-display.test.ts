import { describe, it, expect } from 'vitest'
import { displayName, shortName } from '@/lib/user-display'

describe('user display names', () => {
  const email = 'forrest@valenceanalytical.com'

  it('prefers the name over the email', () => {
    expect(
      displayName({ first_name: 'Forrest', last_name: 'Parker', email })
    ).toBe('Forrest Parker')
    expect(displayName({ email })).toBe(email)
  })

  it('shortens to first name and last initial for narrow spots', () => {
    expect(
      shortName({ first_name: 'Forrest', last_name: 'parker', email })
    ).toBe('Forrest P.')
    expect(shortName({ first_name: 'Guian', email })).toBe('Guian')
    expect(shortName({ email })).toBe('forrest')
  })
})
