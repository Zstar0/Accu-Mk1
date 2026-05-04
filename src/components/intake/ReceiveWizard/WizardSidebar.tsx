import type { SenaiteLookupResult } from '@/lib/api'
import { SampleInfoPanel } from './SampleInfoPanel'

interface Props {
  parentDetails: SenaiteLookupResult | null
  parentDetailsLoading: boolean
  parentDetailsError: string | null
}

export function WizardSidebar({
  parentDetails,
  parentDetailsLoading,
  parentDetailsError,
}: Props) {
  return (
    <aside className="border-r bg-muted/20 p-3 overflow-y-auto h-full flex flex-col">
      <SampleInfoPanel
        details={parentDetails}
        loading={parentDetailsLoading}
        error={parentDetailsError}
      />
    </aside>
  )
}
