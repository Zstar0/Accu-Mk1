import { useUIStore } from '@/store/ui-store'
import type { AccuMarkToolsSubSection } from '@/store/ui-store'
import { OrderExplorer } from '@/components/OrderExplorer'
import { COAExplorer } from '@/components/COAExplorer'

/**
 * AccuMark Tools section - debugging and utility tools.
 * Routes to the active sub-section (follows HPLCAnalysis pattern).
 */
export function AccuMarkTools() {
  const activeSubSection = useUIStore(
    state => state.activeSubSection
  ) as AccuMarkToolsSubSection

  switch (activeSubSection) {
    case 'coa-explorer':
      return <COAExplorer />
    case 'order-explorer':
    default:
      return <OrderExplorer />
  }
}
