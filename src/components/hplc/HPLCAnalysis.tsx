import { useUIStore } from '@/store/ui-store'
import type { HPLCAnalysisSubSection } from '@/store/ui-store'
import { HPLCOverview } from './HPLCOverview'
import { NewAnalysis } from './NewAnalysis'
import { CreateAnalysis } from './CreateAnalysis'
import { PeptideConfig } from './PeptideConfig'
import { AnalysisHistory } from './AnalysisHistory'

export function HPLCAnalysis() {
  const activeSubSection = useUIStore(
    state => state.activeSubSection
  ) as HPLCAnalysisSubSection

  switch (activeSubSection) {
    case 'import-analysis':
      return <NewAnalysis />
    case 'new-analysis':
      return <CreateAnalysis />
    case 'peptide-config':
      return <PeptideConfig />
    case 'analysis-history':
      return <AnalysisHistory />
    case 'overview':
    default:
      return <HPLCOverview />
  }
}
