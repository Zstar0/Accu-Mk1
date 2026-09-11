import type { SenaiteLookupResult } from '@/lib/api'
import { SampleInfoPanel } from './SampleInfoPanel'

interface Props {
  parentDetails: SenaiteLookupResult | null
  parentDetailsLoading: boolean
  parentDetailsError: string | null
  /** Non-destructive refresh failure — the panel stays mounted and warns. */
  parentDetailsRefreshError?: string | null
  /** Parent lookup refetch — re-reads the effective priority after an assign. */
  onPriorityAssigned?: () => void
}

export function WizardSidebar({
  parentDetails,
  parentDetailsLoading,
  parentDetailsError,
  parentDetailsRefreshError,
  onPriorityAssigned,
}: Props) {
  return (
    <aside className="border-r bg-muted/20 p-3 overflow-y-auto h-full flex flex-col">
      <SampleInfoPanel
        details={parentDetails}
        loading={parentDetailsLoading}
        error={parentDetailsError}
        refreshError={parentDetailsRefreshError}
        onPriorityAssigned={onPriorityAssigned}
      />
    </aside>
  )
}
