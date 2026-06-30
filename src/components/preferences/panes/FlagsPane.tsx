import { useState } from 'react'
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
import { entityMeta } from '@/components/flags/flag-entity'
import {
  FlagTypeApiError,
  type FlagType,
  type FlagTypeUpdate,
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

  const types = [...(typesQuery.data ?? [])].sort(
    (a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label)
  )
  const entityTypes = entityTypesQuery.data ?? []

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
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {t('preferences.flags.typesDescription')}
          </p>
          {isAdmin && (
            <Button
              size="sm"
              disabled={createType.isPending}
              onClick={() =>
                createType.mutate({
                  label: t('preferences.flags.newTypeDefaultName'),
                  color: '#3b82f6',
                  kind: 'issue',
                })
              }
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
