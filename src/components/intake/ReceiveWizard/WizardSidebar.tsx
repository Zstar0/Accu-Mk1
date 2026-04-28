import type { SubSample } from '@/lib/api'

interface WizardSidebarProps {
  vials: { sub: SubSample; isThisSession: boolean }[]
  activeSampleId: string | null
  onSelect: (sampleId: string | null) => void
}

export function WizardSidebar(_props: WizardSidebarProps) {
  return null
}
