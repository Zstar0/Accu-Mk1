/**
 * Hash-based navigation persistence.
 *
 * Syncs the Zustand navigation state with the URL hash so that:
 *  - Refreshing the page restores the current section/subsection
 *  - The browser back/forward buttons walk through navigation history
 *
 * Hash format: #section/subsection  (e.g. #dashboard/senaite)
 */

import { useEffect } from 'react'
import { useUIStore, type ActiveSection, type ActiveSubSection } from '@/store/ui-store'

const VALID_SECTIONS = new Set<string>([
  'dashboard',
  'intake',
  'lab-operations',
  'hplc-analysis',
  'accumark-tools',
  'account',
])

function parseNavHash(hash: string): { section: ActiveSection; subSection: ActiveSubSection } | null {
  const clean = hash.replace(/^#/, '')
  if (!clean) return null
  const slash = clean.indexOf('/')
  if (slash === -1) return null
  const section = clean.slice(0, slash)
  const subSection = clean.slice(slash + 1)
  if (!VALID_SECTIONS.has(section) || !subSection) return null
  return {
    section: section as ActiveSection,
    subSection: subSection as ActiveSubSection,
  }
}

/**
 * Call once inside MainWindow (or any component that lives for the entire
 * authenticated session).
 */
export function useHashNavigation() {
  useEffect(() => {
    // 1. Restore navigation state from hash on page load/refresh
    const initial = parseNavHash(window.location.hash)
    if (initial) {
      useUIStore.getState().navigateTo(initial.section, initial.subSection)
    } else {
      // No valid hash — seed the URL from the current store state
      const { activeSection, activeSubSection } = useUIStore.getState()
      history.replaceState(null, '', `#${activeSection}/${activeSubSection}`)
    }

    // 2. Keep the URL hash in sync whenever navigation state changes.
    //    Using history.pushState (not window.location.hash =) avoids
    //    triggering the hashchange event and causing a feedback loop.
    const unsubscribe = useUIStore.subscribe((state, prev) => {
      if (
        state.activeSection !== prev.activeSection ||
        state.activeSubSection !== prev.activeSubSection
      ) {
        const newHash = `#${state.activeSection}/${state.activeSubSection}`
        if (window.location.hash !== newHash) {
          history.pushState(null, '', newHash)
        }
      }
    })

    // 3. Restore navigation when the user presses back/forward.
    //    popstate fires on pushState-based history entries; window.location.hash
    //    already reflects the destination when the handler runs.
    const handlePopState = () => {
      const nav = parseNavHash(window.location.hash)
      if (nav) {
        useUIStore.getState().navigateTo(nav.section, nav.subSection)
      }
    }
    window.addEventListener('popstate', handlePopState)

    return () => {
      unsubscribe()
      window.removeEventListener('popstate', handlePopState)
    }
  }, [])
}
