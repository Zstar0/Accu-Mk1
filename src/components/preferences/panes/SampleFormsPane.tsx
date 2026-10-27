import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SettingsSection } from '../shared/SettingsComponents'
import {
  useCreateSampleForm,
  useSampleForms,
  useUpdateSampleForm,
} from '@/services/sample-forms'
import {
  SAMPLE_FORM_ROUTES,
  type SampleForm,
  type SampleFormRoute,
  type SampleFormUpdate,
} from '@/lib/api-sample-forms'

const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_150px_72px_64px_80px_auto] items-center gap-3'

/** Managed dosage-form list (sample-forms spec). Every user can edit, matching
 *  the spec editor. There is deliberately no delete: a form is retired by
 *  deactivating it, and samples already holding it keep it. */
export function SampleFormsPane() {
  const { t } = useTranslation()
  const forms = useSampleForms()

  if (forms.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (forms.isError || !forms.data) {
    return (
      <p className="text-sm text-destructive">
        {t('preferences.sampleForms.loadError')}
      </p>
    )
  }

  return (
    <div className="space-y-8">
      <SettingsSection title={t('preferences.sampleForms.sectionTitle')}>
        <p className="text-sm text-muted-foreground">
          {t('preferences.sampleForms.sectionHint')}
        </p>
        {forms.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('preferences.sampleForms.empty')}
          </p>
        ) : (
          <div className="rounded-md border">
            <div
              className={`${ROW_GRID} border-b px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground`}
            >
              <span>{t('preferences.sampleForms.colForm')}</span>
              <span>{t('preferences.sampleForms.colRoute')}</span>
              <span>{t('preferences.sampleForms.colOrder')}</span>
              <span className="text-right">
                {t('preferences.sampleForms.colSamples')}
              </span>
              <span>{t('preferences.sampleForms.colStatus')}</span>
              <span />
            </div>
            <div className="divide-y">
              {forms.data.map(f => (
                <FormRow key={f.id} form={f} />
              ))}
            </div>
          </div>
        )}
        <NewFormRow />
      </SettingsSection>
    </div>
  )
}

function RouteOptions() {
  const { t } = useTranslation()
  return SAMPLE_FORM_ROUTES.map(r => (
    <NativeSelectOption key={r} value={r}>
      {t(`preferences.sampleForms.route.${r}`)}
    </NativeSelectOption>
  ))
}

function FormRow({ form }: { form: SampleForm }) {
  const { t } = useTranslation()
  const [name, setName] = useState(form.name)
  const [route, setRoute] = useState<SampleFormRoute>(form.route)
  const [order, setOrder] = useState(String(form.sort_order))
  const update = useUpdateSampleForm()

  const orderNum = Number(order)
  const orderValid = order.trim() !== '' && Number.isInteger(orderNum)
  // Send only what changed: the server merges, and a rename must not rewrite
  // the route or order in the change log.
  const changes: SampleFormUpdate = {}
  if (name.trim() !== form.name) changes.name = name.trim()
  if (route !== form.route) changes.route = route
  if (orderValid && orderNum !== form.sort_order) changes.sort_order = orderNum
  const dirty = Object.keys(changes).length > 0
  const canSave = dirty && name.trim() !== '' && orderValid && !update.isPending

  const toggleActive = (
    <Button
      size="sm"
      variant="ghost"
      disabled={form.is_default || update.isPending}
      onClick={() =>
        update.mutate({ id: form.id, data: { active: !form.active } })
      }
    >
      {form.active
        ? t('preferences.sampleForms.deactivate')
        : t('preferences.sampleForms.activate')}
    </Button>
  )

  return (
    <div
      role="group"
      aria-label={form.name}
      className={`${ROW_GRID} px-3 py-2 text-sm`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={100}
          className="h-8 min-w-0 text-xs"
          aria-label={`${form.name} name`}
        />
        {form.is_default && (
          <Badge variant="secondary">
            {t('preferences.sampleForms.default')}
          </Badge>
        )}
      </div>
      <NativeSelect
        value={route}
        onChange={e => setRoute(e.target.value as SampleFormRoute)}
        className="h-8 text-xs"
        aria-label={`${form.name} route`}
      >
        <RouteOptions />
      </NativeSelect>
      <Input
        type="number"
        step={1}
        value={order}
        onChange={e => setOrder(e.target.value)}
        className="h-8 text-xs"
        aria-label={`${form.name} order`}
      />
      <span className="text-right text-xs text-muted-foreground tabular-nums">
        {form.sample_count}
      </span>
      <Badge variant={form.active ? 'default' : 'outline'} className="w-fit">
        {form.active
          ? t('preferences.sampleForms.active')
          : t('preferences.sampleForms.inactive')}
      </Badge>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          disabled={!canSave}
          onClick={() => update.mutate({ id: form.id, data: changes })}
        >
          {t('preferences.sampleForms.save')}
        </Button>
        {form.is_default ? (
          // A disabled button swallows pointer events, so the tooltip hangs
          // off a focusable wrapper.
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0}>{toggleActive}</span>
            </TooltipTrigger>
            <TooltipContent>
              {t('preferences.sampleForms.deactivateDefaultHint')}
            </TooltipContent>
          </Tooltip>
        ) : (
          toggleActive
        )}
        {!form.is_default && (
          // The server refuses to promote an inactive form.
          <Button
            size="sm"
            variant="ghost"
            disabled={!form.active || update.isPending}
            onClick={() =>
              update.mutate({ id: form.id, data: { is_default: true } })
            }
          >
            {t('preferences.sampleForms.makeDefault')}
          </Button>
        )}
      </div>
    </div>
  )
}

function NewFormRow() {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [route, setRoute] = useState<SampleFormRoute>('injectable')
  const create = useCreateSampleForm()
  const valid = name.trim().length > 0

  return (
    <form
      className="grid grid-cols-[minmax(0,1fr)_150px_auto] items-end gap-3 rounded-md border border-dashed px-3 py-3"
      onSubmit={e => {
        e.preventDefault()
        if (!valid || create.isPending) return
        create.mutate(
          { name: name.trim(), route },
          { onSuccess: () => setName('') }
        )
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="sample-form-new-name" className="text-xs">
          {t('preferences.sampleForms.newName')}
        </Label>
        <Input
          id="sample-form-new-name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('preferences.sampleForms.newNamePlaceholder')}
          maxLength={100}
          className="h-8 text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="sample-form-new-route" className="text-xs">
          {t('preferences.sampleForms.newRoute')}
        </Label>
        <NativeSelect
          id="sample-form-new-route"
          value={route}
          onChange={e => setRoute(e.target.value as SampleFormRoute)}
          className="h-8 text-xs"
        >
          <RouteOptions />
        </NativeSelect>
      </div>
      <Button type="submit" size="sm" disabled={!valid || create.isPending}>
        <Plus className="mr-1 h-4 w-4" />
        {t('preferences.sampleForms.add')}
      </Button>
    </form>
  )
}
