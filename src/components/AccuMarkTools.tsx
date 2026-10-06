import { useUIStore } from '@/store/ui-store'
import type { AccuMarkToolsSubSection } from '@/store/ui-store'
import { OrderExplorer } from '@/components/OrderExplorer'
import { OrderStatusPage } from '@/components/OrderStatusPage'
import { CustomerStatusPage } from '@/components/CustomerStatusPage'
import { COAExplorer } from '@/components/COAExplorer'
import { DigitalCOA } from '@/components/DigitalCOA'
import { CustomerInsights } from '@/components/customers/CustomerInsights'
import { VialStatusPage } from '@/components/vial-board/VialStatusPage'

/**
 * AccuMark Tools section - debugging and utility tools.
 * Routes to the active sub-section (follows HPLCAnalysis pattern).
 *
 * Phase 29 adds `customers` + `customer-detail`: both arms fall through to
 * <CustomerStatusPage />, which internally routes on `activeSubSection`.
 */
export function AccuMarkTools() {
  const activeSubSection = useUIStore(
    state => state.activeSubSection
  ) as AccuMarkToolsSubSection
  const navigateToCustomer = useUIStore(state => state.navigateToCustomer)

  switch (activeSubSection) {
    case 'coa-explorer':
      return <COAExplorer />
    case 'digital-coa':
      return <DigitalCOA />
    case 'order-status':
      return <OrderStatusPage />
    case 'vial-status':
      return <VialStatusPage />
    case 'customer-insights':
      return (
        <CustomerInsights
          onOpenCustomer={key => {
            // wc:<id> keys only; guest rows are not openable until Task 8.
            if (key.startsWith('wc:')) navigateToCustomer(Number(key.slice(3)))
          }}
        />
      )
    case 'customers':
    case 'customer-detail':
      return <CustomerStatusPage />
    case 'order-explorer':
    default:
      return <OrderExplorer />
  }
}
