import { describe, it, expect } from 'vitest'
import {
  captureMimeType,
  supportedResOptions,
  highestSupportedResValue,
  videoConstraints,
  RES_OPTIONS,
} from '@/components/intake/ReceiveWizard/capture-options'

describe('captureMimeType', () => {
  it('maps jpeg and png to canvas MIME types', () => {
    expect(captureMimeType('jpeg')).toBe('image/jpeg')
    expect(captureMimeType('png')).toBe('image/png')
  })
})

describe('supportedResOptions', () => {
  it('returns all presets when capabilities are unknown', () => {
    expect(supportedResOptions(null)).toEqual(RES_OPTIONS)
  })

  it('drops presets above the camera max but always keeps "default"', () => {
    const values = supportedResOptions({
      width: { max: 1280 },
      height: { max: 720 },
    }).map(o => o.value)
    expect(values).toContain('default')
    expect(values).toContain('1280x720')
    expect(values).not.toContain('1920x1080')
    expect(values).not.toContain('3840x2160')
  })
})

describe('highestSupportedResValue', () => {
  it('returns null when capabilities are unknown', () => {
    expect(highestSupportedResValue(null)).toBeNull()
  })

  it('returns the largest preset within the camera max', () => {
    expect(
      highestSupportedResValue({ width: { max: 1920 }, height: { max: 1080 } }),
    ).toBe('1920x1080')
  })

  it('returns null for an empty capabilities object', () => {
    expect(highestSupportedResValue({})).toBeNull()
  })

  it('returns null when only one dimension is known', () => {
    expect(highestSupportedResValue({ width: { max: 1280 } })).toBeNull()
  })
})

describe('videoConstraints', () => {
  it('omits width/height for "default" (camera native)', () => {
    expect(videoConstraints('default')).toEqual({ facingMode: 'environment' })
  })

  it('sets ideal width/height for a sized preset', () => {
    expect(videoConstraints('1920x1080')).toEqual({
      facingMode: 'environment',
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    })
  })
})
