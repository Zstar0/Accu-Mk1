import { describe, it, expect } from 'vitest'
import { useUIStore } from '@/store/ui-store'

describe('ui-store documents viewer target', () => {
  it('navigateToDocument opens the viewer and generic navigateTo clears it', () => {
    const before = useUIStore.getState().navigationKey
    useUIStore.getState().navigateToDocument(7)
    const s = useUIStore.getState()
    expect(s.activeSection).toBe('reports')
    expect(s.activeSubSection).toBe('documents')
    expect(s.documentViewerTargetId).toBe(7)
    expect(s.navigationKey).toBe(before + 1)

    // The sidebar entry dispatches the generic navigateTo — it must always
    // land on the LIST, never re-open whichever document was last viewed.
    useUIStore.getState().navigateTo('reports', 'documents')
    expect(useUIStore.getState().documentViewerTargetId).toBeNull()
  })

  it('clearDocumentViewer drops the target without re-navigating', () => {
    useUIStore.getState().navigateToDocument(42)
    const key = useUIStore.getState().navigationKey
    useUIStore.getState().clearDocumentViewer()
    const s = useUIStore.getState()
    expect(s.documentViewerTargetId).toBeNull()
    // Still on the Documents sub-section, and navigationKey is untouched so
    // MainWindowContent's keyed wrapper does not remount the whole section.
    expect(s.activeSubSection).toBe('documents')
    expect(s.navigationKey).toBe(key)
  })
})
