import { useUIStore } from '@/store/ui-store'

/** Back link for the customer detail views: returns to wherever the user came from. */
export function BackToOrigin() {
  const origin = useUIStore(state => state.customerDetailOrigin)
  const navigateBack = useUIStore(state => state.navigateBackFromCustomer)
  return (
    <button
      type="button"
      className="text-sm text-primary hover:underline mb-4"
      onClick={() => navigateBack()}
    >
      {origin === 'customer-insights'
        ? '← Back to Insights'
        : '← Back to Customers'}
    </button>
  )
}
