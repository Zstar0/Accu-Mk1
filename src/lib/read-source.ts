import { useSyncExternalStore } from 'react'

export type ReadSource = 'senaite' | 'mk1'
const KEY = 'registryReadSource'
const listeners = new Set<() => void>()

export function getReadSource(): ReadSource {
  return sessionStorage.getItem(KEY) === 'mk1' ? 'mk1' : 'senaite'
}

export function setReadSource(source: ReadSource): void {
  sessionStorage.setItem(KEY, source)
  listeners.forEach((l) => l())
}

/** React hook: current read source + setter, shared across components. */
export function useReadSource(): { source: ReadSource; setSource: (s: ReadSource) => void } {
  const source = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    getReadSource,
    (): ReadSource => 'senaite',
  )
  return { source, setSource: setReadSource }
}
