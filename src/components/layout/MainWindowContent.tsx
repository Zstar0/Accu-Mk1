import { cn } from '@/lib/utils'
import { FileSelector } from '@/components/FileSelector'
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
          <div className="p-6">
            <FileSelector />
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
