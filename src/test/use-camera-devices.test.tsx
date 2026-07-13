import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import {
  useCameraDevices,
  CAMERA_DEVICE_STORAGE_KEY,
} from '@/components/intake/ReceiveWizard/use-camera-devices'

type Listener = () => void

function device(kind: string, deviceId: string, label = ''): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: '' } as MediaDeviceInfo
}

// jsdom has no navigator.mediaDevices — install a controllable stand-in whose
// device list can be swapped between enumerations.
function mockMediaDevices(initial: MediaDeviceInfo[]) {
  let current = initial
  const listeners = new Set<Listener>()
  const media = {
    enumerateDevices: vi.fn(() => Promise.resolve(current)),
    addEventListener: vi.fn((_: string, fn: Listener) => listeners.add(fn)),
    removeEventListener: vi.fn((_: string, fn: Listener) =>
      listeners.delete(fn)
    ),
  }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: media,
  })
  return {
    media,
    setDevices(next: MediaDeviceInfo[]) {
      current = next
    },
    fireDeviceChange() {
      listeners.forEach(fn => fn())
    },
  }
}

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices
})

describe('useCameraDevices — device list', () => {
  it('lists only videoinput devices', async () => {
    mockMediaDevices([
      device('videoinput', 'cam-1', 'Webcam'),
      device('audioinput', 'mic-1', 'Mic'),
      device('videoinput', 'cam-2', 'Doc cam'),
    ])
    const { result } = renderHook(() => useCameraDevices())
    await waitFor(() =>
      expect(result.current.devices.map(d => d.deviceId)).toEqual([
        'cam-1',
        'cam-2',
      ])
    )
  })

  it('re-enumerates when a devicechange event fires', async () => {
    const ctl = mockMediaDevices([device('videoinput', 'cam-1')])
    const { result } = renderHook(() => useCameraDevices())
    await waitFor(() => expect(result.current.devices).toHaveLength(1))

    ctl.setDevices([
      device('videoinput', 'cam-1'),
      device('videoinput', 'cam-2'),
    ])
    act(() => ctl.fireDeviceChange())
    await waitFor(() => expect(result.current.devices).toHaveLength(2))
  })

  it('re-enumerates on refreshDevices (labels arrive after permission)', async () => {
    const ctl = mockMediaDevices([device('videoinput', 'cam-1', '')])
    const { result } = renderHook(() => useCameraDevices())
    await waitFor(() => expect(result.current.devices).toHaveLength(1))

    ctl.setDevices([device('videoinput', 'cam-1', 'Webcam')])
    act(() => result.current.refreshDevices())
    await waitFor(() => expect(result.current.devices[0]?.label).toBe('Webcam'))
  })

  it('survives a missing navigator.mediaDevices', () => {
    const { result } = renderHook(() => useCameraDevices())
    expect(result.current.devices).toEqual([])
  })
})

describe('useCameraDevices — persisted selection', () => {
  it('reads the initial selection from localStorage', () => {
    localStorage.setItem(CAMERA_DEVICE_STORAGE_KEY, 'cam-2')
    mockMediaDevices([device('videoinput', 'cam-2')])
    const { result } = renderHook(() => useCameraDevices())
    expect(result.current.selectedDeviceId).toBe('cam-2')
  })

  it('persists an explicit selection', async () => {
    mockMediaDevices([device('videoinput', 'cam-1')])
    const { result } = renderHook(() => useCameraDevices())
    act(() => result.current.setSelectedDeviceId('cam-1'))
    await waitFor(() =>
      expect(localStorage.getItem(CAMERA_DEVICE_STORAGE_KEY)).toBe('cam-1')
    )
  })

  it('clearing the selection removes the stored key', async () => {
    localStorage.setItem(CAMERA_DEVICE_STORAGE_KEY, 'cam-gone')
    mockMediaDevices([device('videoinput', 'cam-1')])
    const { result } = renderHook(() => useCameraDevices())
    act(() => result.current.setSelectedDeviceId(''))
    await waitFor(() =>
      expect(localStorage.getItem(CAMERA_DEVICE_STORAGE_KEY)).toBeNull()
    )
  })
})
