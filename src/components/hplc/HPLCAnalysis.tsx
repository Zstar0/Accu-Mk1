import { useUIStore } from '@/store/ui-store'
import type { HPLCAnalysisSubSection } from '@/store/ui-store'
import { HPLCOverview } from './HPLCOverview'
import { NewAnalysis } from './NewAnalysis'
import { CreateAnalysis } from './CreateAnalysis'
import { AnalysisHistory } from './AnalysisHistory'
import { SamplePreps } from './SamplePreps'

export function HPLCAnalysis() {
  const activeSubSection = useUIStore(
    state => state.activeSubSection
  ) as HPLCAnalysisSubSection

  switch (activeSubSection) {
    case 'import-analysis':
      return <NewAnalysis />
    case 'new-analysis':
      return <CreateAnalysis />
    case 'analysis-history':
      return <AnalysisHistory />
    case 'sample-preps':
      return <SamplePreps />
    case 'overview':
    default:
      return <HPLCOverview />
  }
}
