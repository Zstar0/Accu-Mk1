import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { DocumentRow } from '@/lib/api-documents'
import { useDocumentCategories, usePatchDocument } from '@/services/documents'

interface RetitleDialogProps {
  doc: DocumentRow
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Admin-only metadata edit (spec §5.1 PATCH): title, description, category,
 *  effective date. Never touches content or revision. */
export function RetitleDialog({ doc, open, onOpenChange }: RetitleDialogProps) {
  const [title, setTitle] = useState(doc.title)
  const [description, setDescription] = useState(doc.description ?? '')
  const [categoryId, setCategoryId] = useState(String(doc.category_id))
  const [effective, setEffective] = useState(doc.effective_date ?? '')
  const categories = useDocumentCategories(false)
  const patch = usePatchDocument()

  // Repopulate the fields on the open transition. Adjusted during render —
  // React's documented "adjusting state when a prop changes" idiom, not an
  // effect (repo precedent: VialStatusPage.tsx), so it needs no
  // react-hooks/set-state-in-effect suppression. Keying off the transition
  // rather than `doc` identity also means a background refetch of the detail
  // query cannot clobber what the admin is typing.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setTitle(doc.title)
      setDescription(doc.description ?? '')
      setCategoryId(String(doc.category_id))
      setEffective(doc.effective_date ?? '')
    }
  }

  const canSave = title.trim().length > 0 && !patch.isPending

  const save = () => {
    patch.mutate(
      {
        id: doc.id,
        data: {
          title: title.trim(),
          description: description.trim() || null,
          category_id: Number(categoryId),
          effective_date: effective || null,
        },
      },
      { onSuccess: () => onOpenChange(false) }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit document details</DialogTitle>
          <DialogDescription>
            {doc.code} · revision {doc.revision}. Content is not changed here;
            publish a new revision for that.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="doc-title">Title</Label>
            <Input
              id="doc-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="doc-description">Short description</Label>
            <Textarea
              id="doc-description"
              rows={3}
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="doc-category">Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger id="doc-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(categories.data ?? []).map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="doc-effective">Effective date</Label>
              <Input
                id="doc-effective"
                type="date"
                value={effective}
                onChange={e => setEffective(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {patch.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
