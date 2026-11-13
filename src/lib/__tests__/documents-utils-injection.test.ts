import { describe, expect, it } from 'vitest'
import { buildViewerSrcDoc } from '@/components/documents/documents-utils'
import {
  INJECT_CLOSE,
  INJECT_OPEN,
} from '@/components/documents/annotations/stripViewerInjection'

describe('buildViewerSrcDoc', () => {
  it('stamps the theme and injects the bridge by absolute URL inside markers, before </head>', () => {
    const out = buildViewerSrcDoc(
      '<html><head><title>t</title></head><body>b</body></html>',
      'dark',
      { '--primary': 'oklch(0.5 0 0)' }
    )
    expect(out).toMatch(/<html data-theme="dark">/)
    const start = out.indexOf(INJECT_OPEN)
    const end = out.indexOf(INJECT_CLOSE)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(out.indexOf('</head>')).toBeGreaterThan(end)
    const block = out.slice(start, end)
    expect(block).toMatch(
      /<script src="http:\/\/[^"]+\/pn-bridge\.v\d+\.js"><\/script>/
    )
    expect(block).toContain('--pn-primary: oklch(0.5 0 0)')
    expect(block).not.toContain('--primary:')
    expect(block).not.toContain('plannotator-bridge-ready') // the bridge body is not inlined
  })
})
