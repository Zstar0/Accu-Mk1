/**
 * getWordpressUrl resolution order:
 *   1. sessionStorage WP override (accu_mk1_wp_url_override) — used by
 *      dev stacks whose WP lives on a non-standard port
 *   2. KNOWN_ENVIRONMENTS match on the active API URL (follows the
 *      admin environment switcher, like getSenaiteUrl)
 *   3. VITE_WORDPRESS_URL build-time env var
 *   4. https://accumarklabs.local
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { getWordpressUrl } from '@/lib/api-profiles'

describe('getWordpressUrl', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('prefers the session WP URL override (dev-stack case)', () => {
    sessionStorage.setItem('accu_mk1_wp_url_override', 'http://localhost:5535')
    expect(getWordpressUrl()).toBe('http://localhost:5535')
  })

  it('follows the active API environment when it is a known environment', () => {
    sessionStorage.setItem(
      'accu_mk1_api_url_override',
      'https://accumk1.valenceanalytical.com/api'
    )
    expect(getWordpressUrl()).toBe('https://accumarklabs.com')
  })

  it('falls back to the build-time default for an unknown API override', () => {
    // Stack case without a WP override: API override not in KNOWN_ENVIRONMENTS
    sessionStorage.setItem('accu_mk1_api_url_override', 'http://localhost:5530')
    expect(getWordpressUrl()).toBe('https://accumarklabs.local')
  })

  it('returns the default when nothing is overridden', () => {
    expect(getWordpressUrl()).toBe('https://accumarklabs.local')
  })
})
