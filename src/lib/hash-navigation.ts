/**
 * Hash-based navigation persistence.
 *
 * Syncs the Zustand navigation state with the URL hash so that:
 *  - Refreshing the page restores the current section/subsection
 *  - The browser back/forward buttons walk through navigation history
 *
 * Hash format: #section/subsection          (e.g. #dashboard/senaite)
 *              #section/subsection?id=value  (e.g. #dashboard/sample-details?id=P-0091)
 *
 * Sub-sections that carry a target ID:
 *  - dashboard/sample-details   → sampleDetailsTargetId
 *  - accumark-tools/order-explorer → orderExplorerTargetOrderId
 *  - hplc-analysis/peptide-config  → peptideConfigTargetId
 */

import { useEffect } from 'react'
import { useUIStore, type ActiveSection, type ActiveSubSection } from '@/store/ui-store'

const VALID_SECTIONS = new Set<string>([
  'dashboard',
  'senaite',
  'intake',
  'lab-operations',
  'hplc-analysis',
  'accumark-tools',
  'account',
])

interface ParsedNav {
  section: ActiveSection
  subSection: ActiveSubSection
  targetId: string | null
}

function parseNavHash(hash: string): ParsedNav | null {
  const clean = hash.replace(/^#/, '')
  if (!clean) return null

  // Split path from query: "dashboard/sample-details?id=P-0091"
  const qIdx = clean.indexOf('?')
  const path = qIdx === -1 ? clean : clean.slice(0, qIdx)
  const query = qIdx === -1 ? '' : clean.slice(qIdx + 1)

  const slash = path.indexOf('/')
  if (slash === -1) return null
  const section = path.slice(0, slash)
  const subSection = path.slice(slash + 1)
  if (!VALID_SECTIONS.has(section) || !subSection) return null

  // Extract ?id= parameter
  let targetId: string | null = null
  if (query) {
    const params = new URLSearchParams(query)
    targetId = params.get('id')
  }

  return {
    section: section as ActiveSection,
    subSection: subSection as ActiveSubSection,
    targetId,
  }
}

/** Apply a parsed nav to the store, including any target ID. */
function applyNavToStore(nav: ParsedNav) {
  const store = useUIStore.getState()
  const { section, subSection, targetId } = nav

  // Use the specialized navigators when a target ID is present
  // Sample IDs are always uppercase (e.g. PB-0056) — normalize for case-insensitive URLs
  if (subSection === 'sample-details' && targetId) {
    store.navigateToSample(targetId.toUpperCase())
  } else if (subSection === 'order-explorer' && targetId) {
    store.navigateToOrderExplorer(targetId)
  } else if (subSection === 'peptide-config' && targetId) {
    store.navigateToPeptide(Number(targetId))
  } else {
    store.navigateTo(section, subSection)
  }
}

/** Build the hash string from the current store state, including target IDs. */
function buildHash(state: {
  activeSection: string
  activeSubSection: string
  sampleDetailsTargetId: string | null
  orderExplorerTargetOrderId: string | null
  peptideConfigTargetId: number | null
}): string {
  let hash = `#${state.activeSection}/${state.activeSubSection}`

  // Append ?id= for sub-sections that carry a target
  if (state.activeSubSection === 'sample-details' && state.sampleDetailsTargetId) {
    hash += `?id=${encodeURIComponent(state.sampleDetailsTargetId)}`
  } else if (state.activeSubSection === 'order-explorer' && state.orderExplorerTargetOrderId) {
    hash += `?id=${encodeURIComponent(state.orderExplorerTargetOrderId)}`
  } else if (state.activeSubSection === 'peptide-config' && state.peptideConfigTargetId != null) {
    hash += `?id=${encodeURIComponent(String(state.peptideConfigTargetId))}`
  }

  return hash
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
      applyNavToStore(initial)
    } else {
      // No valid hash — seed the URL from the current store state
      const state = useUIStore.getState()
      history.replaceState(null, '', buildHash(state))
    }

    // 2. Keep the URL hash in sync whenever navigation state changes.
    //    Using history.pushState (not window.location.hash =) avoids
    //    triggering the hashchange event and causing a feedback loop.
    const unsubscribe = useUIStore.subscribe((state, prev) => {
      if (
        state.activeSection !== prev.activeSection ||
        state.activeSubSection !== prev.activeSubSection ||
        state.sampleDetailsTargetId !== prev.sampleDetailsTargetId ||
        state.orderExplorerTargetOrderId !== prev.orderExplorerTargetOrderId ||
        state.peptideConfigTargetId !== prev.peptideConfigTargetId
      ) {
        const newHash = buildHash(state)
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
        applyNavToStore(nav)
      }
    }
    window.addEventListener('popstate', handlePopState)

    return () => {
      unsubscribe()
      window.removeEventListener('popstate', handlePopState)
    }
  }, [])
}
