import { Button } from '@/components/ui/button'

export function EditModeBar({
  saving,
  onSave,
  onCancel,
}: {
  saving: boolean
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b bg-amber-100 px-3 py-1 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-100"
    >
      <span className="font-medium">Editing · unsaved</span>
      <span className="text-muted-foreground">
        Click into the page and change text. Ctrl+B and Ctrl+I work.
      </span>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" onClick={onSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  )
}
