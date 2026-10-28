import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsSection } from '../shared/SettingsComponents'
import { useAuthStore } from '@/store/auth-store'
import {
  useCreateDocumentCategory,
  useCreateDocumentSpace,
  useDeleteDocumentCategory,
  useDeleteDocumentSpace,
  useDocumentCategories,
  useDocumentSpaceGrants,
  useDocumentSpaces,
  useReplaceDocumentSpaceGrants,
  useUpdateDocumentCategory,
  useUpdateDocumentSpace,
} from '@/services/documents'
import { useGroups } from '@/services/groups'
import type {
  DocumentCategory,
  DocumentSpace,
  DocumentSpaceVisibility,
} from '@/lib/api-documents'

/** Managed document categories (spec §3.1, §8.4). Read-only with a notice
 *  for non-admins, matching the other settings panes. */
export function DocumentsPane() {
  const { t } = useTranslation()
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const categories = useDocumentCategories(false)
  const spaces = useDocumentSpaces(true)

  if (categories.isLoading || spaces.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (categories.isError || !categories.data || spaces.isError) {
    return (
      <p className="text-sm text-destructive">
        {t('preferences.documents.loadError')}
      </p>
    )
  }

  return (
    <div className="space-y-8">
      {!isAdmin && (
        <p className="text-sm text-muted-foreground">
          {t('preferences.documents.readOnly')}
        </p>
      )}
      <SettingsSection title={t('preferences.documents.spaces.sectionTitle')}>
        <p className="text-sm text-muted-foreground">
          {t('preferences.documents.spaces.sectionHint')}
        </p>
        <div className="divide-y rounded-md border">
          {(spaces.data ?? []).map(sp => (
            <SpaceRow key={sp.id} space={sp} readOnly={!isAdmin} />
          ))}
        </div>
        {isAdmin && <NewSpaceForm />}
      </SettingsSection>
      <SettingsSection title={t('preferences.documents.sectionTitle')}>
        <p className="text-sm text-muted-foreground">
          {t('preferences.documents.sectionHint')}
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
  const { t } = useTranslation()
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
        placeholder={t('preferences.documents.descriptionPlaceholder')}
        className="h-8 text-xs"
        aria-label={`${category.code_prefix} description`}
      />
      <div className="flex items-center gap-2">
        <Badge variant={category.active ? 'default' : 'outline'}>
          {category.active
            ? t('preferences.documents.active')
            : t('preferences.documents.inactive')}
        </Badge>
        <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">
          {t('preferences.documents.docCount', {
            count: category.document_count,
          })}
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
              {t('preferences.documents.save')}
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
              {category.active
                ? t('preferences.documents.deactivate')
                : t('preferences.documents.activate')}
            </Button>
            {category.document_count === 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate(category.id)}
              >
                {t('preferences.documents.delete')}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function NewCategoryForm() {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [prefix, setPrefix] = useState('')
  const [description, setDescription] = useState('')
  const create = useCreateDocumentCategory()
  const valid =
    name.trim().length > 0 && /^[A-Za-z0-9]{2,10}$/.test(prefix.trim())

  return (
    <form
      className="grid grid-cols-[90px_1fr_1fr_auto] items-end gap-3 rounded-md border border-dashed px-3 py-3"
      onSubmit={e => {
        e.preventDefault()
        if (!valid || create.isPending) return
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
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="doc-cat-new-prefix" className="text-xs">
          {t('preferences.documents.newPrefix')}
        </Label>
        <Input
          id="doc-cat-new-prefix"
          value={prefix}
          onChange={e => setPrefix(e.target.value.toUpperCase())}
          placeholder={t('preferences.documents.newPrefixPlaceholder')}
          maxLength={10}
          className="h-8 font-mono text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="doc-cat-new-name" className="text-xs">
          {t('preferences.documents.newName')}
        </Label>
        <Input
          id="doc-cat-new-name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('preferences.documents.newNamePlaceholder')}
          className="h-8 text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="doc-cat-new-desc" className="text-xs">
          {t('preferences.documents.newDescription')}
        </Label>
        <Input
          id="doc-cat-new-desc"
          value={description}
          onChange={e => setDescription(e.target.value)}
          className="h-8 text-xs"
        />
      </div>
      <Button type="submit" size="sm" disabled={!valid || create.isPending}>
        <Plus className="mr-1 h-4 w-4" />
        {t('preferences.documents.add')}
      </Button>
    </form>
  )
}

function SpaceRow({
  space,
  readOnly,
}: {
  space: DocumentSpace
  readOnly: boolean
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(space.name)
  const [description, setDescription] = useState(space.description ?? '')
  const [showGroups, setShowGroups] = useState(false)
  const update = useUpdateDocumentSpace()
  const remove = useDeleteDocumentSpace()
  const isGeneral = space.slug === 'general'
  const dirty =
    name.trim() !== space.name ||
    (description.trim() || null) !== space.description

  return (
    <div
      data-testid={`doc-space-row-${space.slug}`}
      className="px-3 py-2 text-sm"
    >
      <div className="grid grid-cols-[120px_1fr_1fr_auto] items-center gap-3">
        <span className="font-mono text-xs">{space.slug}</span>
        <Input
          id={`doc-space-name-${space.id}`}
          value={name}
          onChange={e => setName(e.target.value)}
          disabled={readOnly}
          className="h-8 text-xs"
          aria-label={`${space.slug} name`}
        />
        <Input
          id={`doc-space-desc-${space.id}`}
          value={description}
          onChange={e => setDescription(e.target.value)}
          disabled={readOnly}
          placeholder={t('preferences.documents.descriptionPlaceholder')}
          className="h-8 text-xs"
          aria-label={`${space.slug} description`}
        />
        <div className="flex items-center gap-2">
          <Badge
            variant={
              space.visibility === 'restricted' ? 'secondary' : 'outline'
            }
          >
            {t(`preferences.documents.spaces.${space.visibility}`)}
          </Badge>
          <Badge variant={space.is_active ? 'default' : 'outline'}>
            {space.is_active
              ? t('preferences.documents.active')
              : t('preferences.documents.inactive')}
          </Badge>
          <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">
            {t('preferences.documents.docCount', {
              count: space.document_count,
            })}
          </span>
          {!readOnly && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={!dirty || update.isPending || !name.trim()}
                onClick={() =>
                  update.mutate({
                    id: space.id,
                    data: {
                      name: name.trim(),
                      description: description.trim() || null,
                    },
                  })
                }
              >
                {t('preferences.documents.save')}
              </Button>
              {!isGeneral && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate({
                      id: space.id,
                      data: {
                        visibility:
                          space.visibility === 'restricted'
                            ? 'company'
                            : 'restricted',
                      },
                    })
                  }
                >
                  {space.visibility === 'restricted'
                    ? t('preferences.documents.spaces.makeCompany')
                    : t('preferences.documents.spaces.restrict')}
                </Button>
              )}
              {!isGeneral && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate({
                      id: space.id,
                      data: { is_active: !space.is_active },
                    })
                  }
                >
                  {space.is_active
                    ? t('preferences.documents.deactivate')
                    : t('preferences.documents.activate')}
                </Button>
              )}
              {space.visibility === 'restricted' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowGroups(v => !v)}
                >
                  {t('preferences.documents.spaces.groups')}
                </Button>
              )}
              {!isGeneral && space.document_count === 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(space.id)}
                >
                  {t('preferences.documents.delete')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {isGeneral && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('preferences.documents.spaces.generalNote')}
        </p>
      )}
      {showGroups && <GrantsEditor spaceId={space.id} />}
    </div>
  )
}

function GrantsEditor({ spaceId }: { spaceId: number }) {
  const { t } = useTranslation()
  const grants = useDocumentSpaceGrants(spaceId)
  const groups = useGroups(false)
  const replace = useReplaceDocumentSpaceGrants()
  const [selected, setSelected] = useState<Set<number> | null>(null)
  const current = selected ?? new Set(grants.data ?? [])

  if (grants.isLoading || groups.isLoading || !groups.data) {
    return (
      <Loader2 className="mt-2 h-4 w-4 animate-spin text-muted-foreground" />
    )
  }
  if (groups.data.length === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        {t('preferences.documents.spaces.noGroups')}
      </p>
    )
  }
  const toggle = (id: number) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  return (
    <div className="mt-2 rounded-md border border-dashed p-3">
      <div className="grid gap-1 sm:grid-cols-2">
        {groups.data.map(g => (
          <label key={g.id} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={current.has(g.id)}
              onChange={() => toggle(g.id)}
              aria-label={g.name}
            />
            <span>{g.name}</span>
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <Button
          size="sm"
          disabled={replace.isPending || selected === null}
          onClick={() =>
            replace.mutate(
              { id: spaceId, groupIds: [...current].sort((a, b) => a - b) },
              { onSuccess: () => setSelected(null) }
            )
          }
        >
          {t('preferences.documents.spaces.saveAccess')}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t('preferences.documents.spaces.accessHint')}
        </span>
      </div>
    </div>
  )
}

function NewSpaceForm() {
  const { t } = useTranslation()
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [visibility, setVisibility] =
    useState<DocumentSpaceVisibility>('company')
  const create = useCreateDocumentSpace()
  const valid =
    name.trim().length > 0 && /^[a-z0-9][a-z0-9-]{0,59}$/.test(slug.trim())

  return (
    <form
      className="grid grid-cols-[160px_1fr_160px_auto] items-end gap-3 rounded-md border border-dashed px-3 py-3"
      onSubmit={e => {
        e.preventDefault()
        if (!valid || create.isPending) return
        create.mutate(
          { slug: slug.trim(), name: name.trim(), visibility },
          {
            onSuccess: () => {
              setSlug('')
              setName('')
              setVisibility('company')
            },
          }
        )
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="doc-space-new-slug" className="text-xs">
          {t('preferences.documents.spaces.newSlug')}
        </Label>
        <Input
          id="doc-space-new-slug"
          value={slug}
          onChange={e => setSlug(e.target.value.toLowerCase())}
          placeholder={t('preferences.documents.spaces.newSlugPlaceholder')}
          maxLength={60}
          className="h-8 font-mono text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="doc-space-new-name" className="text-xs">
          {t('preferences.documents.spaces.newName')}
        </Label>
        <Input
          id="doc-space-new-name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('preferences.documents.spaces.newNamePlaceholder')}
          className="h-8 text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="doc-space-new-visibility" className="text-xs">
          {t('preferences.documents.spaces.newVisibility')}
        </Label>
        <Select
          value={visibility}
          onValueChange={v => setVisibility(v as DocumentSpaceVisibility)}
        >
          <SelectTrigger id="doc-space-new-visibility" className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="company">
              {t('preferences.documents.spaces.company')}
            </SelectItem>
            <SelectItem value="restricted">
              {t('preferences.documents.spaces.restricted')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" size="sm" disabled={!valid || create.isPending}>
        <Plus className="mr-1 h-4 w-4" />
        {t('preferences.documents.spaces.add')}
      </Button>
    </form>
  )
}
