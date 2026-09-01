/** COA console step labels follow the coa_generation source: mk1 reads the
 *  native registry (read-independence — zero SENAITE reads), while the PDF
 *  attach still writes to SENAITE in both modes. Step IDS are load-bearing
 *  (errorStepFor maps failure text onto them) and must not vary by mode. */
import { describe, it, expect } from 'vitest'
import { generateSteps } from '@/components/senaite/SampleDetails'

describe('generateSteps — coa_generation source awareness', () => {
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

  it('mk1 mode reads the registry but still attaches to SENAITE', () => {
    const labels = generateSteps('mk1').map(s => s.label)
    expect(labels[0]).toBe('Reading sample registry')
    // Writes are unchanged by read-independence — attach label stays.
    expect(labels[4]).toBe('Attaching to SENAITE')
    expect(labels.slice(1, 4)).toEqual([
      'Running COABuilder',
      'Reserving verification code',
      'Uploading PDF to S3',
    ])
  })

  it('step ids are identical across modes (errorStepFor contract)', () => {
    const ids = (m: 'senaite' | 'mk1') => generateSteps(m).map(s => s.id)
    expect(ids('mk1')).toEqual(ids('senaite'))
    expect(ids('senaite')).toEqual([
      'senaite',
      'coabuilder',
      'verification',
      's3',
      'attach',
    ])
  })
})
