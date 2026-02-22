import { cn } from '@/lib/utils'
import { FileSelector } from '@/components/FileSelector'
import { BatchReview } from '@/components/BatchReview'
import { AccuMarkTools } from '@/components/AccuMarkTools'
import { ChromatographViewer } from '@/components/ChromatographViewer'
import { HPLCAnalysis } from '@/components/hplc/HPLCAnalysis'
import { OrderDashboard } from '@/components/dashboard/OrderDashboard'
import { AnalyticsDashboard } from '@/components/dashboard/AnalyticsDashboard'
import { SenaiteDashboard } from '@/components/dashboard/SenaiteDashboard'
import { ReceiveSample } from '@/components/intake/ReceiveSample'
import { UserManagement } from '@/components/auth/UserManagement'
import { ChangePassword } from '@/components/auth/ChangePassword'
import { ScrollArea } from '@/components/ui/scroll-area'
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

  // Render Lab Operations content based on sub-section
  const renderLabOperationsContent = () => {
    switch (activeSubSection) {
      case 'chromatographs':
        return <ChromatographViewer />
      case 'sample-intake':
      default:
        // Default Lab Operations view (legacy)
        return (
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-6 p-6">
              <FileSelector />
              <BatchReview />
            </div>
          </ScrollArea>
        )
    }
  }

  // Render section content based on active section
  const renderSectionContent = () => {
    switch (activeSection) {
      case 'dashboard':
        if (activeSubSection === 'analytics') return <AnalyticsDashboard />
        if (activeSubSection === 'senaite') return <SenaiteDashboard />
        return <OrderDashboard />
      case 'intake':
        return <ReceiveSample />
      case 'lab-operations':
        return renderLabOperationsContent()
      case 'hplc-analysis':
        return <HPLCAnalysis />
      case 'accumark-tools':
        return <AccuMarkTools />
      case 'account':
        if (activeSubSection === 'user-management' && isAdmin) {
          return <UserManagement />
        }
        return <ChangePassword />
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
