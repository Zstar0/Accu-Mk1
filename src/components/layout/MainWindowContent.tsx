import { cn } from '@/lib/utils'
import { FileSelector } from '@/components/FileSelector'
import { BatchReview } from '@/components/BatchReview'
import { ScrollArea } from '@/components/ui/scroll-area'

interface MainWindowContentProps {
  children?: React.ReactNode
  className?: string
}

export function MainWindowContent({
  children,
  className,
}: MainWindowContentProps) {
  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      {children || (
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-6 p-6">
            <FileSelector />
            <BatchReview />
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
