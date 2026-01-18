import { cn } from '@/lib/utils'
import { FileSelector } from '@/components/FileSelector'
import { BatchReview } from '@/components/BatchReview'
import { AccuMarkTools } from '@/components/AccuMarkTools'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useUIStore } from '@/store/ui-store'

interface MainWindowContentProps {
  children?: React.ReactNode
  className?: string
}

export function MainWindowContent({
  children,
  className,
}: MainWindowContentProps) {
  const activeSection = useUIStore(state => state.activeSection)

  // Render section content based on active section
  const renderSectionContent = () => {
    switch (activeSection) {
      case 'lab-operations':
        return (
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-6 p-6">
              <FileSelector />
              <BatchReview />
            </div>
          </ScrollArea>
        )
      case 'accumark-tools':
        return <AccuMarkTools />
      default:
        return null
    }
  }

  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      {children || renderSectionContent()}
    </div>
  )
}
