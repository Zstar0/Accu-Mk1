import { ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'

/** Tasks entry button: sits between Worksheets and Flags in the top bar and
 *  opens the Tasks page (the Flags button opens the flyout). */
export function TasksHeaderButton() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="gap-1.5 h-7 px-2.5 bg-accent text-foreground hover:bg-accent/80 hover:shadow-sm cursor-pointer"
      onClick={() => useUIStore.getState().navigateTo('tasks', 'overview')}
    >
      <ListChecks className="h-3.5 w-3.5" />
      <span className="text-xs">Tasks</span>
    </Button>
  )
}

export default TasksHeaderButton
