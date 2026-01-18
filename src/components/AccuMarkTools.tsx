import { Wrench } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { OrderExplorer } from '@/components/OrderExplorer'

/**
 * AccuMark Tools section - debugging and utility tools
 */
export function AccuMarkTools() {
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Wrench className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">AccuMark Tools</h1>
            <p className="text-sm text-muted-foreground">
              Utilities and tools for lab operations
            </p>
          </div>
        </div>

        {/* Order Explorer */}
        <OrderExplorer />
      </div>
    </ScrollArea>
  )
}

