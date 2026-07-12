import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type {
  RequirementEntry,
  RequirementKind,
  WorkflowCategory,
  WorkflowScope,
  WorkflowState,
  WorkflowStateCreate,
  WorkflowStateUpdate,
  WorkflowTransition,
  WorkflowTransitionCreate,
  WorkflowTransitionUpdate,
} from '@/lib/workflow-api'

const CATEGORY_OPTIONS: WorkflowCategory[] = ['active', 'terminal', 'exception']
const REQUIREMENT_KINDS: RequirementKind[] = [
  'all_analyses_in_state',
  'field_present',
  'role_at_least',
  'manual',
]

// ── create state ────────────────────────────────────────────────────────

interface CreateStateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: WorkflowScope
  onSubmit: (body: WorkflowStateCreate) => void
  isPending: boolean
}

export function CreateStateDialog({
  open,
  onOpenChange,
  scope,
  onSubmit,
  isPending,
}: CreateStateDialogProps) {
  const { t } = useTranslation()
  const [slug, setSlug] = useState('')
  const [label, setLabel] = useState('')
  const [category, setCategory] = useState<WorkflowCategory>('active')

  useEffect(() => {
    if (open) {
      setSlug('')
      setLabel('')
      setCategory('active')
    }
  }, [open])

  const canSubmit = slug.trim().length > 0 && label.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('preferences.workflow.addState')}</DialogTitle>
          <DialogDescription>
            {t('preferences.workflow.addStateDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="wf-state-slug">
              {t('preferences.workflow.slug')}
            </Label>
            <Input
              id="wf-state-slug"
              value={slug}
              disabled={isPending}
              autoComplete="off"
              onChange={e => setSlug(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-state-label">
              {t('preferences.workflow.label')}
            </Label>
            <Input
              id="wf-state-label"
              value={label}
              disabled={isPending}
              autoComplete="off"
              onChange={e => setLabel(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-state-category">
              {t('preferences.workflow.category')}
            </Label>
            <Select
              value={category}
              onValueChange={v => setCategory(v as WorkflowCategory)}
            >
              <SelectTrigger id="wf-state-category" disabled={isPending}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map(c => (
                  <SelectItem key={c} value={c}>
                    {t(`preferences.workflow.category.${c}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {t('preferences.workflow.cancel')}
          </Button>
          <Button
            onClick={() =>
              onSubmit({
                entity_scope: scope,
                slug: slug.trim(),
                label: label.trim(),
                category,
              })
            }
            disabled={isPending || !canSubmit}
          >
            {isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {t('preferences.workflow.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── create transition ───────────────────────────────────────────────────

interface CreateTransitionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  states: WorkflowState[]
  onSubmit: (body: WorkflowTransitionCreate) => void
  isPending: boolean
}

export function CreateTransitionDialog({
  open,
  onOpenChange,
  states,
  onSubmit,
  isPending,
}: CreateTransitionDialogProps) {
  const { t } = useTranslation()
  const [fromStateId, setFromStateId] = useState<string>('')
  const [toStateId, setToStateId] = useState<string>('')
  const [verb, setVerb] = useState('')
  const [label, setLabel] = useState('')

  useEffect(() => {
    if (open) {
      setFromStateId(states[0] ? String(states[0].id) : '')
      setToStateId(states[1] ? String(states[1].id) : '')
      setVerb('')
      setLabel('')
    }
  }, [open, states])

  const canSubmit =
    fromStateId.length > 0 && toStateId.length > 0 && verb.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('preferences.workflow.addTransition')}</DialogTitle>
          <DialogDescription>
            {t('preferences.workflow.addTransitionDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="wf-transition-from">
                {t('preferences.workflow.fromState')}
              </Label>
              <Select value={fromStateId} onValueChange={setFromStateId}>
                <SelectTrigger id="wf-transition-from" disabled={isPending}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {states.map(s => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wf-transition-to">
                {t('preferences.workflow.toState')}
              </Label>
              <Select value={toStateId} onValueChange={setToStateId}>
                <SelectTrigger id="wf-transition-to" disabled={isPending}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {states.map(s => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-transition-verb">
              {t('preferences.workflow.verb')}
            </Label>
            <Input
              id="wf-transition-verb"
              value={verb}
              disabled={isPending}
              autoComplete="off"
              onChange={e => setVerb(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-transition-label">
              {t('preferences.workflow.label')}
            </Label>
            <Input
              id="wf-transition-label"
              value={label}
              disabled={isPending}
              autoComplete="off"
              onChange={e => setLabel(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {t('preferences.workflow.cancel')}
          </Button>
          <Button
            onClick={() =>
              onSubmit({
                from_state_id: Number(fromStateId),
                to_state_id: Number(toStateId),
                verb: verb.trim(),
                label: label.trim() || null,
              })
            }
            disabled={isPending || !canSubmit}
          >
            {isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {t('preferences.workflow.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── state detail sheet ──────────────────────────────────────────────────

interface StateDetailSheetProps {
  state: WorkflowState
  isAdmin: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (body: WorkflowStateUpdate) => void
  onDelete: () => void
  isSaving: boolean
  isDeleting: boolean
}

export function StateDetailSheet({
  state,
  isAdmin,
  open,
  onOpenChange,
  onSave,
  onDelete,
  isSaving,
  isDeleting,
}: StateDetailSheetProps) {
  const { t } = useTranslation()
  // Initialized once from props, not effect-resynced — the parent
  // conditionally renders this sheet (`{selectedState && <StateDetailSheet
  // .../>}`), so switching states (or closing) always fully unmounts it
  // first. Mirrors the TypeCard/KindCard idiom in FlagsPane.tsx.
  const [label, setLabel] = useState(state.label)
  const [description, setDescription] = useState(state.description ?? '')
  const [category, setCategory] = useState<WorkflowCategory>(state.category)
  const [color, setColor] = useState(state.color ?? '#94a3b8')
  const [sortOrder, setSortOrder] = useState(String(state.sort_order))

  const readOnly = !isAdmin

  const commitLabel = () => {
    const next = label.trim()
    if (!next) {
      setLabel(state.label)
      return
    }
    if (next !== state.label) onSave({ label: next })
  }

  const commitDescription = () => {
    const next = description.trim() || null
    if (next !== state.description) onSave({ description: next })
  }

  const commitColor = () => {
    if (color === (state.color ?? '#94a3b8')) return
    onSave({ color })
  }

  const commitSortOrder = () => {
    const next = Number(sortOrder)
    if (Number.isFinite(next) && next !== state.sort_order) {
      onSave({ sort_order: next })
    } else {
      setSortOrder(String(state.sort_order))
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {state.label}
            {state.is_builtin && (
              <Badge variant="outline">
                {t('preferences.workflow.builtin')}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>{state.slug}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 overflow-y-auto px-4">
          <div className="flex flex-wrap gap-2">
            <Badge variant={state.is_active ? 'secondary' : 'outline'}>
              {state.is_active
                ? t('preferences.workflow.active')
                : t('preferences.workflow.inactive')}
            </Badge>
            <Badge variant="secondary">
              {t('preferences.workflow.usage', { count: state.usage_count })}
            </Badge>
            {state.usage_count === 0 && !state.is_builtin && (
              <Badge variant="outline">
                {t('preferences.workflow.notYetReachable')}
              </Badge>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wf-state-detail-label">
              {t('preferences.workflow.label')}
            </Label>
            <Input
              id="wf-state-detail-label"
              value={label}
              disabled={readOnly || isSaving}
              onChange={e => setLabel(e.target.value)}
              onBlur={commitLabel}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wf-state-detail-description">
              {t('preferences.workflow.description')}
            </Label>
            <Textarea
              id="wf-state-detail-description"
              rows={3}
              value={description}
              disabled={readOnly || isSaving}
              onChange={e => setDescription(e.target.value)}
              onBlur={commitDescription}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wf-state-detail-category">
              {t('preferences.workflow.category')}
            </Label>
            <Select
              value={category}
              disabled={readOnly || isSaving}
              onValueChange={v => {
                const next = v as WorkflowCategory
                setCategory(next)
                onSave({ category: next })
              }}
            >
              <SelectTrigger id="wf-state-detail-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map(c => (
                  <SelectItem key={c} value={c}>
                    {t(`preferences.workflow.category.${c}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wf-state-detail-color">
              {t('preferences.workflow.color')}
            </Label>
            <input
              id="wf-state-detail-color"
              type="color"
              value={color}
              disabled={readOnly || isSaving}
              onChange={e => setColor(e.target.value)}
              onBlur={commitColor}
              className="h-8 w-16 cursor-pointer rounded-md border bg-transparent p-0.5 disabled:cursor-default"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wf-state-detail-sort">
              {t('preferences.workflow.sortOrder')}
            </Label>
            <Input
              id="wf-state-detail-sort"
              type="number"
              value={sortOrder}
              disabled={readOnly || isSaving}
              onChange={e => setSortOrder(e.target.value)}
              onBlur={commitSortOrder}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={state.is_active}
              disabled={readOnly || isSaving}
              onCheckedChange={v => onSave({ is_active: v })}
            />
            {t('preferences.workflow.active')}
          </label>
        </div>

        {isAdmin && (
          <SheetFooter>
            <Button
              variant="destructive"
              disabled={isDeleting}
              onClick={onDelete}
            >
              {isDeleting ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-4 w-4" />
              )}
              {t('preferences.workflow.deleteState')}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ── transition detail sheet ─────────────────────────────────────────────

interface TransitionDetailSheetProps {
  transition: WorkflowTransition
  stateLabel: (id: number) => string
  isAdmin: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (body: WorkflowTransitionUpdate) => void
  onDelete: () => void
  isSaving: boolean
  isDeleting: boolean
}

export function TransitionDetailSheet({
  transition,
  stateLabel,
  isAdmin,
  open,
  onOpenChange,
  onSave,
  onDelete,
  isSaving,
  isDeleting,
}: TransitionDetailSheetProps) {
  const { t } = useTranslation()
  // Initialized once from props (see StateDetailSheet — same unmount-on-
  // switch guarantee from the parent's conditional render).
  const [label, setLabel] = useState(transition.label ?? '')
  const [description, setDescription] = useState(transition.description ?? '')
  const [requirements, setRequirements] = useState<RequirementEntry[]>(
    transition.requirements
  )

  const readOnly = !isAdmin

  const commitLabel = () => {
    const next = label.trim() || null
    if (next !== transition.label) onSave({ label: next })
  }

  const commitDescription = () => {
    const next = description.trim() || null
    if (next !== transition.description) onSave({ description: next })
  }

  const addRequirement = () => {
    // Default to 'manual' — the only kind whose value may stay null, so a
    // freshly-added row never trips the backend's 422 before the admin has
    // had a chance to fill it in.
    setRequirements([
      ...requirements,
      { kind: 'manual', value: null, note: null },
    ])
  }

  const updateRequirement = (
    index: number,
    patch: Partial<RequirementEntry>
  ) => {
    setRequirements(reqs =>
      reqs.map((r, i) => (i === index ? { ...r, ...patch } : r))
    )
  }

  const removeRequirement = (index: number) => {
    // Local-only — like every other row edit, a removal commits via the
    // explicit Save button below (not eagerly), so a batch of edits +
    // removals lands as one PATCH.
    setRequirements(reqs => reqs.filter((_, i) => i !== index))
  }

  const saveRequirements = () => {
    // Client-side gate mirrors the backend rule (non-manual kinds require a
    // value) so we don't round-trip a guaranteed 422 — but a 422 that slips
    // through (e.g. a race) still surfaces via the mutation's onError toast.
    const invalid = requirements.some(
      r => r.kind !== 'manual' && !r.value?.trim()
    )
    if (invalid) return
    onSave({ requirements })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {transition.label || transition.verb}
            {transition.is_builtin && (
              <Badge variant="outline">
                {t('preferences.workflow.builtin')}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            {stateLabel(transition.from_state_id)} →{' '}
            {stateLabel(transition.to_state_id)}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 overflow-y-auto px-4">
          <div className="flex flex-wrap gap-2">
            <Badge variant={transition.is_active ? 'secondary' : 'outline'}>
              {transition.is_active
                ? t('preferences.workflow.active')
                : t('preferences.workflow.inactive')}
            </Badge>
          </div>

          <div className="space-y-1.5">
            <Label>{t('preferences.workflow.verb')}</Label>
            {/* Verb is display-only here — renaming it collides with the
                backend's duplicate-verb-per-source-state uniqueness check,
                out of scope for this task's form-driven CRUD. */}
            <Input value={transition.verb} disabled readOnly />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wf-transition-detail-label">
              {t('preferences.workflow.label')}
            </Label>
            <Input
              id="wf-transition-detail-label"
              value={label}
              disabled={readOnly || isSaving}
              onChange={e => setLabel(e.target.value)}
              onBlur={commitLabel}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wf-transition-detail-description">
              {t('preferences.workflow.description')}
            </Label>
            <Textarea
              id="wf-transition-detail-description"
              rows={3}
              value={description}
              disabled={readOnly || isSaving}
              onChange={e => setDescription(e.target.value)}
              onBlur={commitDescription}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={transition.is_active}
              disabled={readOnly || isSaving}
              onCheckedChange={v => onSave({ is_active: v })}
            />
            {t('preferences.workflow.active')}
          </label>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('preferences.workflow.requirements')}</Label>
              {!readOnly && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isSaving}
                  onClick={addRequirement}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {t('preferences.workflow.addRequirement')}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('preferences.workflow.requirementsHint')}
            </p>

            <div className="space-y-2">
              {requirements.map((req, index) => (
                <div
                  key={index}
                  className="flex flex-col gap-2 rounded-md border p-2"
                >
                  <div className="flex items-center gap-2">
                    <Select
                      value={req.kind}
                      disabled={readOnly || isSaving}
                      onValueChange={v =>
                        updateRequirement(index, {
                          kind: v as RequirementKind,
                          // Clear a stale value when swapping to 'manual' so
                          // we never submit a value the UI has hidden.
                          value: v === 'manual' ? null : req.value,
                        })
                      }
                    >
                      <SelectTrigger
                        aria-label={t('preferences.workflow.requirementKind')}
                        className="flex-1"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {REQUIREMENT_KINDS.map(k => (
                          <SelectItem key={k} value={k}>
                            {t(`preferences.workflow.kind.${k}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-destructive"
                        aria-label={t('preferences.workflow.removeRequirement')}
                        disabled={isSaving}
                        onClick={() => removeRequirement(index)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                  {req.kind !== 'manual' && (
                    <Input
                      aria-label={t('preferences.workflow.requirementValue')}
                      placeholder={t('preferences.workflow.requirementValue')}
                      value={req.value ?? ''}
                      disabled={readOnly || isSaving}
                      onChange={e =>
                        updateRequirement(index, { value: e.target.value })
                      }
                    />
                  )}
                  <Input
                    aria-label={t('preferences.workflow.requirementNote')}
                    placeholder={t('preferences.workflow.requirementNote')}
                    value={req.note ?? ''}
                    disabled={readOnly || isSaving}
                    onChange={e =>
                      updateRequirement(index, { note: e.target.value || null })
                    }
                  />
                </div>
              ))}
            </div>

            {!readOnly && (
              <Button
                size="sm"
                variant="secondary"
                disabled={isSaving}
                onClick={saveRequirements}
              >
                {isSaving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {t('preferences.workflow.save')}
              </Button>
            )}
          </div>
        </div>

        {isAdmin && (
          <SheetFooter>
            <Button
              variant="destructive"
              disabled={isDeleting}
              onClick={onDelete}
            >
              {isDeleting ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-4 w-4" />
              )}
              {t('preferences.workflow.deleteTransition')}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}
