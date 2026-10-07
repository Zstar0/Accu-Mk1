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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { displayName } from '@/lib/user-display'
import { useCreateDocument, useDocumentCategories } from '@/services/documents'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import { checkHtmlFile, starterHtml } from './new-document-template'

interface NewDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Source = 'blank' | 'file'

/** Admin-only: a brand-new controlled document, born as a draft. A blank page
 *  opens straight into edit mode; an uploaded HTML file opens in view mode.
 *  The server mints the code from the category prefix and inlines the theme. */
export function NewDocumentDialog({
  open,
  onOpenChange,
}: NewDocumentDialogProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [effective, setEffective] = useState('')
  const [source, setSource] = useState<Source>('blank')
  const [file, setFile] = useState<{ name: string; html: string } | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const categories = useDocumentCategories(true)
  const create = useCreateDocument()
  const user = useAuthStore(s => s.user)
  const openForEditing = useUIStore(s => s.openDocumentForEditing)
  const navigateToDocument = useUIStore(s => s.navigateToDocument)

  // Preselect the first active category once the list arrives (state adjusted
  // during render, the idiom RetitleDialog uses).
  const first = categories.data?.[0]
  if (!categoryId && first) setCategoryId(String(first.id))
  const category = (categories.data ?? []).find(
    c => String(c.id) === categoryId
  )

  const reset = () => {
    setTitle('')
    setDescription('')
    setEffective('')
    setSource('blank')
    setFile(null)
    setFileError(null)
  }

  const onFile = (f: File | undefined) => {
    setFile(null)
    setFileError(null)
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      const problem = checkHtmlFile(text)
      if (problem) setFileError(problem)
      else setFile({ name: f.name, html: text })
    }
    reader.onerror = () => setFileError('Could not read that file')
    reader.readAsText(f)
  }

  const canCreate =
    title.trim().length > 0 &&
    !!category &&
    (source === 'blank' || !!file) &&
    !create.isPending

  const submit = () => {
    if (!category) return
    const html = source === 'blank' ? starterHtml(title) : file?.html
    if (!html) return
    create.mutate(
      {
        title: title.trim(),
        html,
        category_id: category.id,
        description: description.trim() || null,
        effective_date: effective || null,
        author: user ? displayName(user) : undefined,
      },
      {
        onSuccess: row => {
          onOpenChange(false)
          reset()
          if (source === 'blank') openForEditing(row.id)
          else navigateToDocument(row.id)
        },
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New document</DialogTitle>
          <DialogDescription>
            Creates a draft. Activate it from the viewer when it is ready.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="new-doc-title">Title</Label>
            <Input
              id="new-doc-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="new-doc-category">Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger id="new-doc-category">
                  <SelectValue placeholder="Pick a category" />
                </SelectTrigger>
                <SelectContent>
                  {(categories.data ?? []).map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {category && (
                <p className="text-xs text-muted-foreground">
                  Code will be minted as {category.code_prefix}-NNNN
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-doc-effective">Effective date</Label>
              <Input
                id="new-doc-effective"
                type="date"
                value={effective}
                onChange={e => setEffective(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-doc-description">Short description</Label>
            <Textarea
              id="new-doc-description"
              rows={2}
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Content</Label>
            <RadioGroup
              value={source}
              onValueChange={v => setSource(v as Source)}
              className="gap-2"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="blank" id="new-doc-blank" />
                <Label htmlFor="new-doc-blank" className="font-normal">
                  Start from a blank page (opens in edit mode)
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="file" id="new-doc-upload" />
                <Label htmlFor="new-doc-upload" className="font-normal">
                  Upload an HTML file
                </Label>
              </div>
            </RadioGroup>
            {source === 'file' && (
              <div className="grid gap-1.5 pl-6">
                <Label htmlFor="new-doc-file" className="sr-only">
                  HTML file
                </Label>
                <Input
                  id="new-doc-file"
                  type="file"
                  accept=".html,.htm,text/html"
                  onChange={e => onFile(e.target.files?.[0])}
                />
                {fileError && (
                  <p className="text-xs text-destructive">{fileError}</p>
                )}
                {file && !fileError && (
                  <p className="text-xs text-muted-foreground">
                    {file.name} ready
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canCreate}>
            {create.isPending ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
