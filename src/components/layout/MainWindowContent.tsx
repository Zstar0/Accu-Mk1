import { cn } from '@/lib/utils'
import { AccuMarkTools } from '@/components/AccuMarkTools'
import { ChromatographViewer } from '@/components/ChromatographViewer'
import { HPLCAnalysis } from '@/components/hplc/HPLCAnalysis'
import { InstrumentsPage } from '@/components/hplc/InstrumentsPage'
import { MethodsPage } from '@/components/hplc/MethodsPage'
import { PeptideConfig } from '@/components/hplc/PeptideConfig'
import { AnalysisServicesPage } from '@/components/hplc/AnalysisServicesPage'
import { OrderDashboard } from '@/components/dashboard/OrderDashboard'
import { AnalyticsDashboard } from '@/components/dashboard/AnalyticsDashboard'
import { SenaiteDashboard } from '@/components/senaite/SenaiteDashboard'
import { SampleDetails } from '@/components/senaite/SampleDetails'
import { SampleEventLog } from '@/components/senaite/SampleEventLog'
import { ReceiveSample } from '@/components/intake/ReceiveSample'
import { UserManagement } from '@/components/auth/UserManagement'
import { ProfilePage } from '@/components/auth/ProfilePage'
import { useUIStore } from '@/store/ui-store'
import { useAuthStore } from '@/store/auth-store'

interface MainWindowContentProps {
  children?: React.ReactNode
  className?: string
}

export function MainWindowContent({
  children,
  className,
}: MainWindowContentProps) {
  const activeSection = useUIStore(state => state.activeSection)
  const activeSubSection = useUIStore(state => state.activeSubSection)
  const navigationKey = useUIStore(state => state.navigationKey)
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')

  // Render section content based on active section
  const renderSectionContent = () => {
    switch (activeSection) {
      case 'dashboard':
        if (activeSubSection === 'analytics') return <AnalyticsDashboard />
        return <OrderDashboard />
      case 'senaite':
        if (activeSubSection === 'event-log') return <SampleEventLog />
        if (activeSubSection === 'sample-details') return <SampleDetails />
        if (activeSubSection === 'receive-sample') return <ReceiveSample />
        return <SenaiteDashboard />
      case 'lims':
        if (activeSubSection === 'instruments') return <InstrumentsPage />
        if (activeSubSection === 'methods') return <MethodsPage />
        if (activeSubSection === 'peptide-config') return <PeptideConfig />
        if (activeSubSection === 'analysis-services') return <AnalysisServicesPage />
        return <InstrumentsPage />
      case 'hplc-analysis':
        return <HPLCAnalysis />
      case 'accumark-tools':
        if (activeSubSection === 'chromatographs') return <ChromatographViewer />
        return <AccuMarkTools />
      case 'account':
        if (activeSubSection === 'user-management' && isAdmin) {
          return <UserManagement />
        }
        return <ProfilePage />
      default:
        return null
    }
  }

  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      {children || <div key={navigationKey} className="contents">{renderSectionContent()}</div>}
    </div>
  )
}
