import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface CreateWorksheetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedUids: string[]
  onConfirm: (title: string, notes: string) => void
  isPending: boolean
}

function generateWorksheetTitle(): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `WS-${yyyy}-${mm}-${dd}-001`
}

export function CreateWorksheetDialog({
  open,
  onOpenChange,
  selectedUids,
  onConfirm,
  isPending,
}: CreateWorksheetDialogProps) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')

  // Reset fields and generate a fresh title each time the dialog opens
  useEffect(() => {
    if (open) {
      setTitle(generateWorksheetTitle())
      setNotes('')
    }
  }, [open])

  function handleConfirm() {
    onConfirm(title.trim(), notes.trim())
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Worksheet</DialogTitle>
          <DialogDescription>
            {selectedUids.length} sample{selectedUids.length !== 1 ? 's' : ''} selected
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Title field */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="ws-title">
              Title
            </label>
            <input
              id="ws-title"
              type="text"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              value={title}
              onChange={e => setTitle(e.target.value)}
              disabled={isPending}
            />
          </div>

          {/* Notes field */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="ws-notes">
              Notes <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <textarea
              id="ws-notes"
              rows={3}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              placeholder="Add notes..."
              value={notes}
              onChange={e => setNotes(e.target.value)}
              disabled={isPending}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={handleConfirm}
            disabled={isPending || !title.trim()}
          >
            {isPending && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
