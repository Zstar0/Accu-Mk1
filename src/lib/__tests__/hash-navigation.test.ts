import { describe, it, expect } from 'vitest'
import { useUIStore } from '@/store/ui-store'
import { applyNavToStore, buildHash, parseNavHash } from '@/lib/hash-navigation'

function applyHash(hash: string) {
  const nav = parseNavHash(hash)
  if (!nav) throw new Error(`unparseable hash ${hash}`)
  applyNavToStore(nav)
}

function currentHash() {
  return buildHash(useUIStore.getState())
}

describe('documents space in the hash', () => {
  it('parses ?space= into the store and builds it back', () => {
    applyHash('#reports/documents?space=accounting')
    expect(useUIStore.getState().documentsSpaceSlug).toBe('accounting')
    expect(useUIStore.getState().documentViewerTargetId).toBeNull()
    expect(currentHash()).toBe('#reports/documents?space=accounting')
    useUIStore.getState().navigateToDocument(12)
    expect(currentHash()).toBe('#reports/documents?id=12')
    useUIStore.getState().clearDocumentViewer()
    expect(currentHash()).toBe('#reports/documents?space=accounting')
    useUIStore.getState().navigateToDocumentSpace(null)
    expect(currentHash()).toBe('#reports/documents')
  })

  it('honours id when a hash carries both', () => {
    applyHash('#reports/documents?space=accounting&id=7')
    expect(useUIStore.getState().documentViewerTargetId).toBe(7)
  })
})
