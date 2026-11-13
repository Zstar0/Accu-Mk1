/** COA console step labels follow two things: the coa_generation read source
 *  (mk1 reads the native registry, zero SENAITE reads) and whether the sample
 *  is native-born (no SENAITE AR: the backend skips the SENAITE attach on
 *  generate and relays the native status on publish instead of a SENAITE
 *  transition). Step IDS are load-bearing (inferErrorStepIdx maps failure
 *  text onto them) and never vary by mode or origin. */
import { describe, it, expect } from 'vitest'
import {
  generateSteps,
  publishSteps,
} from '@/components/senaite/coa-console-steps'

describe('generateSteps: read source and native-born awareness', () => {
  it('senaite mode keeps the classic labels', () => {
    const labels = generateSteps('senaite').map(s => s.label)
    expect(labels).toEqual([
      'Connecting to SENAITE',
      'Running COABuilder',
      'Reserving verification code',
      'Uploading PDF to S3',
      'Attaching to SENAITE',
    ])
  })

  it('mk1 mode reads the registry; a SENAITE-born sample still attaches to SENAITE', () => {
    const labels = generateSteps('mk1').map(s => s.label)
    expect(labels[0]).toBe('Reading sample registry')
    expect(labels[4]).toBe('Attaching to SENAITE')
    expect(labels.slice(1, 4)).toEqual([
      'Running COABuilder',
      'Reserving verification code',
      'Uploading PDF to S3',
    ])
  })

  it('a native-born sample never names SENAITE', () => {
    const labels = generateSteps('mk1', { nativeBorn: true }).map(s => s.label)
    expect(labels[0]).toBe('Reading sample registry')
    expect(labels[4]).toBe('Recording in sample registry')
    expect(labels.some(l => /senaite/i.test(l))).toBe(false)
  })

  it('step ids are identical across modes and origins (inferErrorStepIdx contract)', () => {
    const ids = (m: 'senaite' | 'mk1', nativeBorn = false) =>
      generateSteps(m, { nativeBorn }).map(s => s.id)
    expect(ids('mk1')).toEqual(ids('senaite'))
    expect(ids('mk1', true)).toEqual(ids('senaite'))
    expect(ids('senaite')).toEqual([
      'senaite',
      'coabuilder',
      'verification',
      's3',
      'attach',
    ])
  })
})

describe('publishSteps: native-born awareness', () => {
  it('defaults to the SENAITE transition', () => {
    expect(publishSteps().map(s => s.label)).toEqual([
      'Locating draft generation',
      'Publishing primary COA',
      'Publishing additional COAs',
      'Notifying WordPress',
      'SENAITE transition',
    ])
  })

  it('a native-born sample updates the sample registry instead', () => {
    const labels = publishSteps({ nativeBorn: true }).map(s => s.label)
    expect(labels[4]).toBe('Updating sample registry')
    expect(labels.some(l => /senaite/i.test(l))).toBe(false)
  })

  it('step ids never vary', () => {
    expect(publishSteps({ nativeBorn: true }).map(s => s.id)).toEqual(
      publishSteps().map(s => s.id)
    )
    expect(publishSteps().map(s => s.id)).toEqual([
      'draft',
      'primary',
      'additional',
      'wordpress',
      'senaite_tx',
    ])
  })
})
