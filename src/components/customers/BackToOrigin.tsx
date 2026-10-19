import { useUIStore } from '@/store/ui-store'

/** Back link for the customer detail views: returns to wherever the user came from. */
export function BackToOrigin() {
  const origin = useUIStore(state => state.customerDetailOrigin)
  const navigateToCustomers = useUIStore(state => state.navigateToCustomers)
  return (
    <button
      type="button"
      className="text-sm text-primary hover:underline mb-4"
      onClick={() => navigateToCustomers()}
    >
      {origin === 'customer-insights'
        ? '← Back to Insights'
        : '← Back to Customers'}
    </button>
  )
}
