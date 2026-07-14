import { useCallback, useEffect, useState } from 'react'

/** localStorage key for the tech's preferred capture camera. */
export const CAMERA_DEVICE_STORAGE_KEY = 'wizard-camera-device'

/**
 * Video-input device list + persisted camera selection for the Receive-wizard
 * capture panels. '' means "no explicit choice" — panels fall back to
 * facingMode and let the browser pick. Call refreshDevices after getUserMedia
 * resolves: device labels are blank until the permission grant.
 */
export function useCameraDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem(CAMERA_DEVICE_STORAGE_KEY) ?? ''
  })

  const refreshDevices = useCallback(() => {
    const media =
      typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!media?.enumerateDevices) return
    media
      .enumerateDevices()
      .then(all => setDevices(all.filter(d => d.kind === 'videoinput')))
      .catch(() => {
        // device list is an optional enhancement — keep whatever we had
      })
  }, [])

  useEffect(() => {
    const media =
      typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!media?.enumerateDevices) return
    refreshDevices()
    // Track hot-plug (e.g. USB doc-cam) while the panel is open.
    media.addEventListener?.('devicechange', refreshDevices)
    return () => {
      media.removeEventListener?.('devicechange', refreshDevices)
    }
  }, [refreshDevices])

  // Persist explicit choices; clearing the choice (stale/unplugged device)
  // must also clear storage or every mount would retry the dead device.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (selectedDeviceId) {
      localStorage.setItem(CAMERA_DEVICE_STORAGE_KEY, selectedDeviceId)
    } else {
      localStorage.removeItem(CAMERA_DEVICE_STORAGE_KEY)
    }
  }, [selectedDeviceId])

  return { devices, selectedDeviceId, setSelectedDeviceId, refreshDevices }
}
