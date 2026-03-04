import { useUIStore } from '@/store/ui-store'
import type { HPLCAnalysisSubSection } from '@/store/ui-store'
import { HPLCOverview } from './HPLCOverview'
import { NewAnalysis } from './NewAnalysis'
import { CreateAnalysis } from './CreateAnalysis'
import { PeptideConfig } from './PeptideConfig'
import { AnalysisHistory } from './AnalysisHistory'
import { SamplePreps } from './SamplePreps'
import { MethodsPage } from './MethodsPage'
import { InstrumentsPage } from './InstrumentsPage'

export function HPLCAnalysis() {
  const activeSubSection = useUIStore(
    state => state.activeSubSection
  ) as HPLCAnalysisSubSection

  switch (activeSubSection) {
    case 'import-analysis':
      return <NewAnalysis />
    case 'new-analysis':
      return <CreateAnalysis />
    case 'instruments':
      return <InstrumentsPage />
    case 'methods':
      return <MethodsPage />
    case 'peptide-config':
      return <PeptideConfig />
    case 'analysis-history':
      return <AnalysisHistory />
    case 'sample-preps':
      return <SamplePreps />
    case 'overview':
    default:
      return <HPLCOverview />
  }
}
