import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSection } from '../shared/SettingsComponents'
import { useAuthStore } from '@/store/auth-store'
import {
  useCreateDocumentCategory,
  useDeleteDocumentCategory,
  useDocumentCategories,
  useUpdateDocumentCategory,
} from '@/services/documents'
import type { DocumentCategory } from '@/lib/api-documents'

/** Managed document categories (spec §3.1, §8.4). Read-only with a notice
 *  for non-admins, matching the other settings panes. */
export function DocumentsPane() {
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const categories = useDocumentCategories(false)

  if (categories.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (categories.isError || !categories.data) {
    return (
      <p className="text-sm text-destructive">
        Could not load document categories.
      </p>
    )
  }

  return (
    <div className="space-y-8">
      {!isAdmin && (
        <p className="text-sm text-muted-foreground">
          Only administrators can change document categories.
        </p>
      )}
      <SettingsSection title="Document categories">
        <p className="text-sm text-muted-foreground">
          Every published document belongs to one category. The prefix becomes
          the start of its code (ART-0012) and cannot change once a document
          uses it.
        </p>
        <div className="divide-y rounded-md border">
          {categories.data.map(c => (
            <CategoryRow key={c.id} category={c} readOnly={!isAdmin} />
          ))}
        </div>
        {isAdmin && <NewCategoryForm />}
      </SettingsSection>
    </div>
  )
}

function CategoryRow({
  category,
  readOnly,
}: {
  category: DocumentCategory
  readOnly: boolean
}) {
  const [name, setName] = useState(category.name)
  const [description, setDescription] = useState(category.description ?? '')
  const update = useUpdateDocumentCategory()
  const remove = useDeleteDocumentCategory()
  const dirty =
    name.trim() !== category.name ||
    (description.trim() || null) !== category.description

  return (
    <div className="grid grid-cols-[90px_1fr_1fr_auto] items-center gap-3 px-3 py-2 text-sm">
      <span className="font-mono text-xs">{category.code_prefix}</span>
      <Input
        id={`doc-cat-name-${category.id}`}
        value={name}
        onChange={e => setName(e.target.value)}
        disabled={readOnly}
        className="h-8 text-xs"
        aria-label={`${category.code_prefix} name`}
      />
      <Input
        id={`doc-cat-desc-${category.id}`}
        value={description}
        onChange={e => setDescription(e.target.value)}
        disabled={readOnly}
        placeholder="Description"
        className="h-8 text-xs"
        aria-label={`${category.code_prefix} description`}
      />
      <div className="flex items-center gap-2">
        <Badge variant={category.active ? 'default' : 'outline'}>
          {category.active ? 'Active' : 'Inactive'}
        </Badge>
        <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">
          {category.document_count} doc
          {category.document_count === 1 ? '' : 's'}
        </span>
        {!readOnly && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!dirty || update.isPending || !name.trim()}
              onClick={() =>
                update.mutate({
                  id: category.id,
                  data: {
                    name: name.trim(),
                    description: description.trim() || null,
                  },
                })
              }
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() =>
                update.mutate({
                  id: category.id,
                  data: { active: !category.active },
                })
              }
            >
              {category.active ? 'Deactivate' : 'Activate'}
            </Button>
            {category.document_count === 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate(category.id)}
              >
                Delete
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function NewCategoryForm() {
  const [name, setName] = useState('')
  const [prefix, setPrefix] = useState('')
  const [description, setDescription] = useState('')
  const create = useCreateDocumentCategory()
  const valid =
    name.trim().length > 0 && /^[A-Za-z0-9]{2,10}$/.test(prefix.trim())

  return (
    <div className="grid grid-cols-[90px_1fr_1fr_auto] items-end gap-3 rounded-md border border-dashed px-3 py-3">
      <div className="grid gap-1">
        <Label htmlFor="doc-cat-new-prefix" className="text-xs">
          Prefix
        </Label>
        <Input
          id="doc-cat-new-prefix"
          value={prefix}
          onChange={e => setPrefix(e.target.value.toUpperCase())}
          placeholder="VAL"
          maxLength={10}
          className="h-8 font-mono text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="doc-cat-new-name" className="text-xs">
          Name
        </Label>
        <Input
          id="doc-cat-new-name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Validation"
          className="h-8 text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="doc-cat-new-desc" className="text-xs">
          Description
        </Label>
        <Input
          id="doc-cat-new-desc"
          value={description}
          onChange={e => setDescription(e.target.value)}
          className="h-8 text-xs"
        />
      </div>
      <Button
        size="sm"
        disabled={!valid || create.isPending}
        onClick={() =>
          create.mutate(
            {
              name: name.trim(),
              code_prefix: prefix.trim(),
              description: description.trim() || null,
            },
            {
              onSuccess: () => {
                setName('')
                setPrefix('')
                setDescription('')
              },
            }
          )
        }
      >
        <Plus className="mr-1 h-4 w-4" />
        Add
      </Button>
    </div>
  )
}
