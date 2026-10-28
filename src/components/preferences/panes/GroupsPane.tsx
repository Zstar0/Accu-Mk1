import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSection } from '../shared/SettingsComponents'
import { useAuthStore } from '@/store/auth-store'
import {
  useCreateGroup,
  useDeleteGroup,
  useDirectoryUsers,
  useGroupMembers,
  useGroups,
  useReplaceGroupMembers,
  useUpdateGroup,
} from '@/services/groups'
import type { Group } from '@/lib/api-groups'
import type { WorksheetUser } from '@/lib/api'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,59}$/

function userLabel(u: WorksheetUser): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return name ? `${name} (${u.email})` : u.email
}

/** User groups (spec 2026-09-26 §4.1, §8.8). Groups are the unit of access for
 *  boards and, through board nodes, for flags. Read-only for non-admins. */
export function GroupsPane() {
  const { t } = useTranslation()
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const groups = useGroups(isAdmin)

  if (groups.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (groups.isError || !groups.data) {
    return (
      <p className="text-sm text-destructive">
        {t('preferences.groups.loadError')}
      </p>
    )
  }

  return (
    <div className="space-y-8">
      {!isAdmin && (
        <p className="text-sm text-muted-foreground">
          {t('preferences.groups.readOnly')}
        </p>
      )}
      <SettingsSection title={t('preferences.groups.sectionTitle')}>
        <p className="text-sm text-muted-foreground">
          {t('preferences.groups.sectionHint')}
        </p>
        <div className="divide-y rounded-md border">
          {groups.data.map(g => (
            <GroupRow key={g.id} group={g} readOnly={!isAdmin} />
          ))}
        </div>
        {isAdmin && <NewGroupForm />}
      </SettingsSection>
    </div>
  )
}

function GroupRow({ group, readOnly }: { group: Group; readOnly: boolean }) {
  const { t } = useTranslation()
  const [name, setName] = useState(group.name)
  const [description, setDescription] = useState(group.description ?? '')
  const [membersOpen, setMembersOpen] = useState(false)
  const update = useUpdateGroup()
  const remove = useDeleteGroup()
  const dirty =
    name.trim() !== group.name ||
    (description.trim() || null) !== group.description

  return (
    <div className="px-3 py-2 text-sm">
      <div className="grid grid-cols-[120px_1fr_1fr_auto] items-center gap-3">
        <span className="font-mono text-xs">{group.slug}</span>
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          disabled={readOnly}
          className="h-8 text-xs"
          aria-label={`${group.slug} name`}
        />
        <Input
          value={description}
          onChange={e => setDescription(e.target.value)}
          disabled={readOnly}
          placeholder={t('preferences.groups.descriptionPlaceholder')}
          className="h-8 text-xs"
          aria-label={`${group.slug} description`}
        />
        <div className="flex items-center gap-2">
          <Badge variant={group.is_active ? 'default' : 'outline'}>
            {group.is_active
              ? t('preferences.groups.active')
              : t('preferences.groups.inactive')}
          </Badge>
          <span className="w-20 text-right text-xs text-muted-foreground tabular-nums">
            {t('preferences.groups.memberCount', { count: group.member_count })}
          </span>
          {!readOnly && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setMembersOpen(o => !o)}
              >
                <Users className="mr-1 h-3.5 w-3.5" />
                {t('preferences.groups.members')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!dirty || update.isPending || !name.trim()}
                onClick={() =>
                  update.mutate({
                    id: group.id,
                    data: {
                      name: name.trim(),
                      description: description.trim() || null,
                    },
                  })
                }
              >
                {t('preferences.groups.save')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate({
                    id: group.id,
                    data: { is_active: !group.is_active },
                  })
                }
              >
                {group.is_active
                  ? t('preferences.groups.deactivate')
                  : t('preferences.groups.activate')}
              </Button>
              {group.member_count === 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(group.id)}
                >
                  {t('preferences.groups.delete')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {membersOpen && !readOnly && <MembersEditor groupId={group.id} />}
    </div>
  )
}

function MembersEditor({ groupId }: { groupId: number }) {
  const { t } = useTranslation()
  const members = useGroupMembers(groupId)
  const directory = useDirectoryUsers()
  const replace = useReplaceGroupMembers()
  const [selected, setSelected] = useState<Set<number> | null>(null)
  const current = selected ?? new Set(members.data ?? [])

  if (members.isLoading || directory.isLoading || !directory.data) {
    return (
      <Loader2 className="mt-2 h-4 w-4 animate-spin text-muted-foreground" />
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
        {directory.data.map(u => (
          <label key={u.id} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={current.has(u.id)}
              onChange={() => toggle(u.id)}
              aria-label={userLabel(u)}
            />
            <span>{userLabel(u)}</span>
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <Button
          size="sm"
          disabled={replace.isPending || selected === null}
          onClick={() =>
            replace.mutate(
              { id: groupId, userIds: [...current].sort((a, b) => a - b) },
              { onSuccess: () => setSelected(null) }
            )
          }
        >
          {t('preferences.groups.saveMembers')}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t('preferences.groups.membersHint')}
        </span>
      </div>
    </div>
  )
}

function NewGroupForm() {
  const { t } = useTranslation()
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const create = useCreateGroup()
  const valid = SLUG_RE.test(slug.trim()) && name.trim().length > 0

  return (
    <form
      className="grid grid-cols-[120px_1fr_1fr_auto] items-end gap-3 rounded-md border border-dashed px-3 py-3"
      onSubmit={e => {
        e.preventDefault()
        if (!valid || create.isPending) return
        create.mutate(
          {
            slug: slug.trim(),
            name: name.trim(),
            description: description.trim() || null,
          },
          {
            onSuccess: () => {
              setSlug('')
              setName('')
              setDescription('')
            },
          }
        )
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="group-new-slug" className="text-xs">
          {t('preferences.groups.newSlug')}
        </Label>
        <Input
          id="group-new-slug"
          value={slug}
          onChange={e => setSlug(e.target.value.toLowerCase())}
          placeholder={t('preferences.groups.newSlugPlaceholder')}
          maxLength={60}
          className="h-8 font-mono text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="group-new-name" className="text-xs">
          {t('preferences.groups.newName')}
        </Label>
        <Input
          id="group-new-name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('preferences.groups.newNamePlaceholder')}
          className="h-8 text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="group-new-desc" className="text-xs">
          {t('preferences.groups.newDescription')}
        </Label>
        <Input
          id="group-new-desc"
          value={description}
          onChange={e => setDescription(e.target.value)}
          className="h-8 text-xs"
        />
      </div>
      <Button type="submit" size="sm" disabled={!valid || create.isPending}>
        <Plus className="mr-1 h-4 w-4" />
        {t('preferences.groups.add')}
      </Button>
    </form>
  )
}
