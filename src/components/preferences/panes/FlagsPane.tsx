import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Loader2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { SettingsSection } from '../shared/SettingsComponents'
import { useAuthStore } from '@/store/auth-store'
import {
  useFlagTypes,
  useFlagEntityTypes,
  useCreateFlagType,
  useUpdateFlagType,
  useDeleteFlagType,
} from '@/services/flag-types'
import {
  useRecurring,
  useCreateRecurring,
  useUpdateRecurring,
  useDeleteRecurring,
} from '@/services/flag-recurring'
import {
  useItemKinds,
  useCreateItemKind,
  useUpdateItemKind,
  useDeleteItemKind,
} from '@/services/item-kinds'
import { useFlagUsers, nameForUser } from '@/components/flags/flag-users'
import { entityMeta } from '@/components/flags/flag-entity'
import {
  TypeBucketBoard,
  type Bucket,
} from '@/components/flags/TypeBucketBoard'
import {
  FlagTypeApiError,
  type FlagType,
  type FlagTypeUpdate,
  type FlagItemKind,
  type FlagItemKindUpdate,
  type FlagRecurring,
  type FlagRecurringUpdate,
} from '@/lib/flags-api'

/**
 * Flag Types settings (Plan 5). Admins add/edit/scope/deactivate flag types;
 * non-admins see a read-only view. Mirrors SlaPane's card-per-row pattern and
 * the flag dark look (each card carries its type color as a left accent, echoing
 * the pills in the flyout). Edits commit on blur / on toggle. Deletion is only
 * offered for unused custom types; built-in or in-use types return 409 and the
 * card surfaces the "deactivate instead" path.
 */
export function FlagsPane() {
  const { t } = useTranslation()
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const typesQuery = useFlagTypes({})
  const entityTypesQuery = useFlagEntityTypes()
  const createType = useCreateFlagType()
  const updateType = useUpdateFlagType()
  const deleteType = useDeleteFlagType()
  // Synchronous in-flight guard: `disabled={createType.isPending}` only takes
  // effect on the next render, so a same-tick double-fire of the Add button
  // slips two POSTs through before the button disables. A ref flips
  // immediately, collapsing the burst to one create (and clears on settle so
  // the admin can add the next type).
  const createInFlight = useRef(false)

  // Active item kinds for the scope board's buckets (the per-card chips only
  // scope to code entities; the board is the one place to scope to a kind).
  const activeKindsQuery = useItemKinds({ active_only: true })

  const types = [...(typesQuery.data ?? [])].sort(
    (a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label)
  )
  const entityTypes = entityTypesQuery.data ?? []
  // Board buckets: code entities (Sample, Sub Sample, Worksheet) + active kinds.
  const scopeBuckets: Bucket[] = [
    ...entityTypes.map(slug => ({ slug, label: entityMeta(slug).label })),
    ...[...(activeKindsQuery.data ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(k => ({ slug: k.slug, label: k.label })),
  ]

  if (typesQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (typesQuery.isError) {
    return (
      <p className="text-sm text-destructive">
        {t('preferences.flags.loadError')}
      </p>
    )
  }

  return (
    <div className="space-y-8">
      {!isAdmin && (
        <p className="text-sm text-muted-foreground">
          {t('preferences.flags.readOnly')}
        </p>
      )}

      <SettingsSection title={t('preferences.flags.types')}>
        {/* Concept help — what the knobs on a type actually mean. */}
        <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">
              {t('preferences.flags.kindIssue')}
            </span>{' '}
            — {t('preferences.flags.help.issue')}
          </p>
          <p>
            <span className="font-semibold text-foreground">
              {t('preferences.flags.kindSignal')}
            </span>{' '}
            — {t('preferences.flags.help.signal')}
          </p>
          <p>
            <span className="font-semibold text-foreground">
              {t('preferences.flags.appliesTo')}
            </span>{' '}
            {t('preferences.flags.help.scope')}
          </p>
          <p>
            <span className="font-semibold text-foreground">
              {t('preferences.flags.active')}
            </span>{' '}
            — {t('preferences.flags.help.deactivate')}
          </p>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {t('preferences.flags.typesDescription')}
          </p>
          {isAdmin && (
            <Button
              size="sm"
              disabled={createType.isPending}
              onClick={() => {
                if (createInFlight.current) return
                createInFlight.current = true
                createType.mutate(
                  {
                    label: t('preferences.flags.newTypeDefaultName'),
                    color: '#3b82f6',
                    kind: 'issue',
                  },
                  {
                    onSettled: () => {
                      createInFlight.current = false
                    },
                  }
                )
              }}
            >
              <Plus className="mr-1 h-4 w-4" /> {t('preferences.flags.addType')}
            </Button>
          )}
        </div>

        <div className="space-y-3">
          {types.map(type => (
            <TypeCard
              key={type.id}
              type={type}
              entityTypes={entityTypes}
              readOnly={!isAdmin}
              onSave={data => updateType.mutate({ id: type.id, data })}
              onDelete={onConflict =>
                deleteType.mutate(type.id, {
                  onError: e => {
                    if (e instanceof FlagTypeApiError && e.status === 409)
                      onConflict()
                  },
                })
              }
            />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t('preferences.flags.scope.title')}>
        <p className="text-sm text-muted-foreground">
          {t('preferences.flags.scope.description')}
        </p>
        <TypeBucketBoard
          types={types}
          buckets={scopeBuckets}
          readOnly={!isAdmin}
          onScope={(id, entity_types) =>
            updateType.mutate({ id, data: { entity_types } })
          }
        />
      </SettingsSection>

      <ItemKindsSection readOnly={!isAdmin} />

      {/* Recurring tasks are admin-only config — non-admins never see them, and
          the section's queries only run for admins because it lives in a child
          that mounts only here. */}
      {isAdmin && <RecurringSection types={types} />}
    </div>
  )
}

/**
 * Item kinds (slice 7). The virtual categories a general task can anchor to
 * (General Task, Purchase Task, …). Admins add/rename/recolor/deactivate;
 * non-admins see a read-only list. Mirrors the flag-type card idiom — built-in
 * or in-use kinds return 409 on delete and surface the "deactivate instead"
 * path.
 */
function ItemKindsSection({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation()
  const kindsQuery = useItemKinds()
  const createKind = useCreateItemKind()
  const updateKind = useUpdateItemKind()
  const deleteKind = useDeleteItemKind()
  const createInFlight = useRef(false)

  const kinds = [...(kindsQuery.data ?? [])].sort(
    (a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label)
  )

  return (
    <SettingsSection title={t('preferences.flags.items.title')}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('preferences.flags.items.description')}
        </p>
        {!readOnly && (
          <Button
            size="sm"
            disabled={createKind.isPending}
            onClick={() => {
              if (createInFlight.current) return
              createInFlight.current = true
              createKind.mutate(
                {
                  label: t('preferences.flags.items.newDefault'),
                  color: '#6b7280',
                },
                { onSettled: () => (createInFlight.current = false) }
              )
            }}
          >
            <Plus className="mr-1 h-4 w-4" /> {t('preferences.flags.items.add')}
          </Button>
        )}
      </div>

      <div className="space-y-3">
        {kinds.map(kind => (
          <KindCard
            key={kind.id}
            kind={kind}
            readOnly={readOnly}
            onSave={data => updateKind.mutate({ id: kind.id, data })}
            onDelete={onConflict =>
              deleteKind.mutate(kind.id, {
                onError: e => {
                  if (e instanceof FlagTypeApiError && e.status === 409)
                    onConflict()
                },
              })
            }
          />
        ))}
      </div>
    </SettingsSection>
  )
}

function KindCard({
  kind,
  readOnly,
  onSave,
  onDelete,
}: {
  kind: FlagItemKind
  readOnly: boolean
  onSave: (data: FlagItemKindUpdate) => void
  onDelete: (onConflict: () => void) => void
}) {
  const { t } = useTranslation()
  const [label, setLabel] = useState(kind.label)
  const [color, setColor] = useState(kind.color)
  const [conflict, setConflict] = useState(false)

  const commitLabel = () => {
    if (readOnly) return
    const next = label.trim()
    if (!next) {
      setLabel(kind.label)
      return
    }
    if (next !== kind.label) onSave({ label: next })
  }

  const commitColor = () => {
    if (readOnly || color === kind.color) return
    onSave({ color })
  }

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 rounded-lg border border-l-[3px] p-3 transition-opacity',
        !kind.is_active && 'opacity-60'
      )}
      style={{ borderLeftColor: color }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <input
          type="color"
          value={color}
          disabled={readOnly}
          aria-label={t('preferences.flags.color')}
          onChange={e => setColor(e.target.value)}
          onBlur={commitColor}
          className="h-8 w-8 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5 disabled:cursor-default"
        />
        <Input
          value={label}
          disabled={readOnly}
          aria-label={t('preferences.flags.label')}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          onChange={e => setLabel(e.target.value)}
          onBlur={commitLabel}
          className="h-8 w-48 font-medium"
        />
        {kind.is_builtin && (
          <Badge variant="outline" className="text-[10px]">
            {t('preferences.flags.builtin')}
          </Badge>
        )}
        {!kind.is_active && (
          <Badge variant="secondary" className="text-[10px]">
            {t('preferences.flags.inactive')}
          </Badge>
        )}
        {conflict && (
          <span className="flex items-center gap-1 text-xs text-amber-500">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {t('preferences.flags.deactivateInstead')}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t('preferences.flags.active')}
          <Switch
            checked={kind.is_active}
            disabled={readOnly}
            onCheckedChange={v => onSave({ is_active: v })}
          />
        </label>
        {!readOnly && !kind.is_builtin && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            aria-label={t('preferences.flags.delete')}
            onClick={() => {
              setConflict(false)
              onDelete(() => setConflict(true))
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Recurring-task templates (Slice 5). Admin-only. Each template mints a flag on
 * its cadence; edits commit on blur / on change (same UX as TypeCard).
 */
function RecurringSection({ types }: { types: FlagType[] }) {
  const { t } = useTranslation()
  const recurringQuery = useRecurring()
  const createRecurring = useCreateRecurring()
  const updateRecurring = useUpdateRecurring()
  const deleteRecurring = useDeleteRecurring()
  const users = useFlagUsers()
  const createInFlight = useRef(false)

  // Recurring flags default to a global (no-entity) type — mirror the backend's
  // "general task ⇒ global type" rule; fall back to 'task' before types load.
  const firstGlobalType =
    types.find(type => type.entity_types.length === 0)?.slug ?? 'task'
  const rows = recurringQuery.data ?? []

  return (
    <SettingsSection title={t('preferences.flags.recurring.title')}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('preferences.flags.recurring.description')}
        </p>
        <Button
          size="sm"
          disabled={createRecurring.isPending}
          onClick={() => {
            if (createInFlight.current) return
            createInFlight.current = true
            createRecurring.mutate(
              {
                title: t('preferences.flags.recurring.newDefault'),
                type: firstGlobalType,
                cadence: 'weekly:0',
              },
              { onSettled: () => (createInFlight.current = false) }
            )
          }}
        >
          <Plus className="mr-1 h-4 w-4" />{' '}
          {t('preferences.flags.recurring.add')}
        </Button>
      </div>

      <div className="space-y-3">
        {rows.map(r => (
          <RecurringCard
            key={r.id}
            recurring={r}
            types={types}
            users={users}
            onSave={data => updateRecurring.mutate({ id: r.id, data })}
            onDelete={() => deleteRecurring.mutate(r.id)}
          />
        ))}
      </div>
    </SettingsSection>
  )
}

type CadenceUnit = 'daily' | 'weekly' | 'monthly'
// Days of the week, Monday=0 (matches the backend cadence weekday index).
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function parseCadence(c: string): { unit: CadenceUnit; n: number } {
  if (c.startsWith('weekly:'))
    return { unit: 'weekly', n: Number(c.split(':')[1]) || 0 }
  if (c.startsWith('monthly:'))
    return { unit: 'monthly', n: Number(c.split(':')[1]) || 1 }
  return { unit: 'daily', n: 0 }
}

function formatCadence(unit: CadenceUnit, n: number): string {
  if (unit === 'weekly') return `weekly:${n}`
  if (unit === 'monthly') return `monthly:${n}`
  return 'daily'
}

function RecurringCard({
  recurring,
  types,
  users,
  onSave,
  onDelete,
}: {
  recurring: FlagRecurring
  types: FlagType[]
  users: ReturnType<typeof useFlagUsers>
  onSave: (data: FlagRecurringUpdate) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(recurring.title)
  const { unit, n } = parseCadence(recurring.cadence)

  const commitTitle = () => {
    const next = title.trim()
    if (!next) {
      setTitle(recurring.title)
      return
    }
    if (next !== recurring.title) onSave({ title: next })
  }

  const setCadence = (u: CadenceUnit, num: number) =>
    onSave({ cadence: formatCadence(u, num) })

  return (
    <div className="space-y-3 rounded-lg border p-4">
      {/* Title + active toggle + delete */}
      <div className="flex items-center justify-between gap-2">
        <Input
          value={title}
          aria-label={t('preferences.flags.recurring.titleLabel')}
          onChange={e => setTitle(e.target.value)}
          onBlur={commitTitle}
          className="h-8 w-64 font-medium"
        />
        <div className="flex shrink-0 items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t('preferences.flags.recurring.active')}
            <Switch
              checked={recurring.active}
              onCheckedChange={v => onSave({ active: v })}
            />
          </label>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            aria-label={t('preferences.flags.recurring.delete')}
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Type + cadence + assignee */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {t('preferences.flags.recurring.type')}
          </span>
          <Select
            value={recurring.type}
            onValueChange={v => onSave({ type: v })}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {types.map(type => (
                <SelectItem key={type.slug} value={type.slug}>
                  {type.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {t('preferences.flags.recurring.every')}
          </span>
          <Select
            value={unit}
            onValueChange={v =>
              setCadence(v as CadenceUnit, v === 'monthly' ? 1 : 0)
            }
          >
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">
                {t('preferences.flags.recurring.daily')}
              </SelectItem>
              <SelectItem value="weekly">
                {t('preferences.flags.recurring.weekly')}
              </SelectItem>
              <SelectItem value="monthly">
                {t('preferences.flags.recurring.monthly')}
              </SelectItem>
            </SelectContent>
          </Select>
          {unit === 'weekly' && (
            <Select
              value={String(n)}
              onValueChange={v => setCadence('weekly', Number(v))}
            >
              <SelectTrigger className="h-8 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOW.map((d, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {unit === 'monthly' && (
            <Select
              value={String(n)}
              onValueChange={v => setCadence('monthly', Number(v))}
            >
              <SelectTrigger className="h-8 w-20 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 28 }, (_, i) => i + 1).map(day => (
                  <SelectItem key={day} value={String(day)}>
                    {day}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {t('preferences.flags.recurring.assignee')}
          </span>
          <Select
            value={String(recurring.assignee_id ?? 'none')}
            onValueChange={v =>
              onSave({ assignee_id: v === 'none' ? null : Number(v) })
            }
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                {t('preferences.flags.recurring.unassigned')}
              </SelectItem>
              {[...users.values()].map(u => (
                <SelectItem key={u.id} value={String(u.id)}>
                  {nameForUser(users, u.id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Skip-if-open guard */}
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={recurring.skip_if_open}
          onCheckedChange={v => onSave({ skip_if_open: v })}
        />
        <span>{t('preferences.flags.recurring.skipIfOpen')}</span>
        <span className="text-xs text-muted-foreground">
          — {t('preferences.flags.recurring.skipIfOpenHint')}
        </span>
      </label>
    </div>
  )
}

function TypeCard({
  type,
  entityTypes,
  readOnly,
  onSave,
  onDelete,
}: {
  type: FlagType
  entityTypes: string[]
  readOnly: boolean
  onSave: (data: FlagTypeUpdate) => void
  onDelete: (onConflict: () => void) => void
}) {
  const { t } = useTranslation()
  const [label, setLabel] = useState(type.label)
  const [color, setColor] = useState(type.color)
  const [conflict, setConflict] = useState(false)

  const commitLabel = () => {
    if (readOnly) return
    const next = label.trim()
    if (!next) {
      setLabel(type.label)
      return
    }
    if (next !== type.label) onSave({ label: next })
  }

  const commitColor = () => {
    if (readOnly || color === type.color) return
    onSave({ color })
  }

  const isGlobal = type.entity_types.length === 0
  const toggleEntity = (slug: string) => {
    if (readOnly) return
    const next = type.entity_types.includes(slug)
      ? type.entity_types.filter(s => s !== slug)
      : [...type.entity_types, slug]
    onSave({ entity_types: next })
  }

  return (
    <div
      className={cn(
        'space-y-3 rounded-lg border border-l-[3px] p-4 transition-opacity',
        !type.is_active && 'opacity-60'
      )}
      style={{ borderLeftColor: color }}
    >
      {/* Header: color swatch + label + flags + active toggle / delete */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <input
            type="color"
            value={color}
            disabled={readOnly}
            aria-label={t('preferences.flags.color')}
            onChange={e => setColor(e.target.value)}
            onBlur={commitColor}
            className="h-8 w-8 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5 disabled:cursor-default"
          />
          <Input
            value={label}
            disabled={readOnly}
            aria-label={t('preferences.flags.label')}
            onChange={e => setLabel(e.target.value)}
            onBlur={commitLabel}
            className="h-8 w-48 font-medium"
          />
          {type.is_builtin && (
            <Badge variant="outline" className="text-[10px]">
              {t('preferences.flags.builtin')}
            </Badge>
          )}
          {!type.is_active && (
            <Badge variant="secondary" className="text-[10px]">
              {t('preferences.flags.inactive')}
            </Badge>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t('preferences.flags.active')}
            <Switch
              checked={type.is_active}
              disabled={readOnly}
              onCheckedChange={v => onSave({ is_active: v })}
            />
          </label>
          {!readOnly && !type.is_builtin && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive"
              aria-label={t('preferences.flags.delete')}
              onClick={() => {
                setConflict(false)
                onDelete(() => setConflict(true))
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Kind + blocking */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {t('preferences.flags.kind')}
          </span>
          <Select
            value={type.kind}
            disabled={readOnly}
            onValueChange={v => onSave({ kind: v as 'issue' | 'signal' })}
          >
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="issue">
                {t('preferences.flags.kindIssue')}
              </SelectItem>
              <SelectItem value="signal">
                {t('preferences.flags.kindSignal')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={type.is_blocking}
            disabled={readOnly}
            onCheckedChange={v => onSave({ is_blocking: v })}
          />
          <span>{t('preferences.flags.blocking')}</span>
          <span className="text-xs text-muted-foreground">
            — {t('preferences.flags.blockingHint')}
          </span>
        </label>
      </div>

      {/* Applies-to scope: empty = global (All) */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-sm text-muted-foreground">
          {t('preferences.flags.appliesTo')}
        </span>
        <ScopeChip
          label={t('preferences.flags.allEntities')}
          active={isGlobal}
          disabled={readOnly}
          onClick={() => !isGlobal && onSave({ entity_types: [] })}
        />
        {entityTypes.map(slug => (
          <ScopeChip
            key={slug}
            label={entityMeta(slug).label}
            active={type.entity_types.includes(slug)}
            disabled={readOnly}
            onClick={() => toggleEntity(slug)}
          />
        ))}
      </div>

      {conflict && (
        <p className="flex items-center gap-1.5 text-xs text-amber-500">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t('preferences.flags.deactivateInstead')}
        </p>
      )}
    </div>
  )
}

function ScopeChip({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string
  active: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-transparent text-muted-foreground enabled:hover:bg-muted',
        disabled && 'cursor-default opacity-70'
      )}
    >
      {label}
    </button>
  )
}

export default FlagsPane
