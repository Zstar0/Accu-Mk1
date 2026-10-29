import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, Loader2, Plus } from 'lucide-react'
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SettingsSection } from '../shared/SettingsComponents'
import { SampleFormIcon } from '@/components/common/SampleFormIcon'
import {
  iconKey,
  SAMPLE_FORM_ICONS,
  type SampleFormIconKey,
} from '@/lib/sample-form-icons'
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

// One template for the header, every form row and the add row, with every
// track fixed except the name: an `auto` track sized per row is what let the
// columns drift. The actions track is three fixed slots (Save, Activate or
// Deactivate, Make default) so each button lines up down the list too. Fixed
// tracks are sized to their content so the name keeps the rest of the width.
const ROW_GRID =
  'grid grid-cols-[minmax(160px,1fr)_132px_88px_56px_76px_268px] items-center gap-2'
const ACTION_SLOTS = 'grid grid-cols-[56px_96px_108px] items-center gap-1'

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
              <OrderHeader />
              <span className="text-end">
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

/** The order column only decides where a form sits in the Form pickers, which
 *  a bare number never said. */
function OrderHeader() {
  const { t } = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex w-fit cursor-help items-center gap-1">
          {t('preferences.sampleForms.colOrder')}
          <Info size={11} aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs p-0">
        <div className="flex flex-col gap-1.5 p-3 font-mono text-xs normal-case tracking-normal">
          <div className="border-b border-primary-foreground/20 pb-1.5 font-semibold">
            {t('preferences.sampleForms.colOrder')}
          </div>
          <div>{t('preferences.sampleForms.orderHint')}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/** Themed (Radix) select: a native <select> hands its option list to the OS,
 *  which drew it white on white in dark mode. */
function RouteSelect({
  value,
  onChange,
  id,
  ariaLabel,
}: {
  value: SampleFormRoute
  onChange: (route: SampleFormRoute) => void
  id?: string
  ariaLabel?: string
}) {
  const { t } = useTranslation()
  return (
    <Select value={value} onValueChange={v => onChange(v as SampleFormRoute)}>
      <SelectTrigger
        id={id}
        size="sm"
        className="w-full text-xs"
        aria-label={ariaLabel}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SAMPLE_FORM_ROUTES.map(r => (
          <SelectItem key={r} value={r} className="text-xs">
            {t(`preferences.sampleForms.route.${r}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The form's picker icon. The closed trigger is a square showing only the
 *  drawing (no chevron: it shares the name's track, and a wider trigger cut
 *  long names off); the list names each icon, since a drawing can be misread. */
function IconSelect({
  value,
  onChange,
  id,
  ariaLabel,
}: {
  value: SampleFormIconKey
  onChange: (icon: SampleFormIconKey) => void
  id?: string
  ariaLabel?: string
}) {
  const { t } = useTranslation()
  return (
    <Select value={value} onValueChange={v => onChange(v as SampleFormIconKey)}>
      <SelectTrigger
        id={id}
        size="sm"
        className="w-8 shrink-0 justify-center px-0 [&>svg]:hidden"
        aria-label={ariaLabel}
      >
        <SelectValue>
          <SampleFormIcon icon={value} className="text-foreground" />
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {SAMPLE_FORM_ICONS.map(k => (
          <SelectItem key={k} value={k} className="text-xs">
            <SampleFormIcon icon={k} />
            {t(`preferences.sampleForms.icon.${k}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function FormRow({ form }: { form: SampleForm }) {
  const { t } = useTranslation()
  const [name, setName] = useState(form.name)
  const [route, setRoute] = useState<SampleFormRoute>(form.route)
  const [icon, setIcon] = useState<SampleFormIconKey>(iconKey(form.icon))
  const [order, setOrder] = useState(String(form.sort_order))
  const update = useUpdateSampleForm()

  const orderNum = Number(order)
  const orderValid = order.trim() !== '' && Number.isInteger(orderNum)
  // Send only what changed: the server merges, and a rename must not rewrite
  // the route or order in the change log.
  const changes: SampleFormUpdate = {}
  if (name.trim() !== form.name) changes.name = name.trim()
  if (route !== form.route) changes.route = route
  if (icon !== iconKey(form.icon)) changes.icon = icon
  if (orderValid && orderNum !== form.sort_order) changes.sort_order = orderNum
  const dirty = Object.keys(changes).length > 0
  const canSave = dirty && name.trim() !== '' && orderValid && !update.isPending

  const toggleActive = (
    <Button
      size="sm"
      variant="ghost"
      className="w-full"
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
      <div className="flex min-w-0 items-center gap-1">
        <IconSelect
          value={icon}
          onChange={setIcon}
          ariaLabel={`${form.name} icon`}
        />
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={100}
          className="h-8 min-w-0 px-2 text-xs"
          aria-label={`${form.name} name`}
        />
      </div>
      <RouteSelect
        value={route}
        onChange={setRoute}
        ariaLabel={`${form.name} route`}
      />
      <Input
        type="number"
        step={1}
        value={order}
        onChange={e => setOrder(e.target.value)}
        className="h-8 text-xs tabular-nums"
        aria-label={`${form.name} order`}
      />
      <span className="text-end text-xs text-muted-foreground tabular-nums">
        {form.sample_count}
      </span>
      <Badge variant={form.active ? 'default' : 'outline'} className="w-fit">
        {form.active
          ? t('preferences.sampleForms.active')
          : t('preferences.sampleForms.inactive')}
      </Badge>
      <div className={ACTION_SLOTS}>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
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
        {form.is_default ? (
          // The default form has nothing to promote: its slot says so.
          <Badge variant="secondary" className="justify-self-center">
            {t('preferences.sampleForms.default')}
          </Badge>
        ) : (
          // The server refuses to promote an inactive form.
          <Button
            size="sm"
            variant="ghost"
            className="w-full"
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
  const [icon, setIcon] = useState<SampleFormIconKey>('other')
  const create = useCreateSampleForm()
  const valid = name.trim().length > 0

  return (
    <form
      className={`${ROW_GRID} items-end rounded-md border border-dashed px-3 py-3`}
      onSubmit={e => {
        e.preventDefault()
        if (!valid || create.isPending) return
        create.mutate(
          { name: name.trim(), route, icon },
          {
            onSuccess: () => {
              setName('')
              setIcon('other')
            },
          }
        )
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="sample-form-new-name" className="text-xs">
          {t('preferences.sampleForms.newName')}
        </Label>
        <div className="flex min-w-0 items-center gap-1">
          <IconSelect
            value={icon}
            onChange={setIcon}
            ariaLabel={t('preferences.sampleForms.newIcon')}
          />
          <Input
            id="sample-form-new-name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('preferences.sampleForms.newNamePlaceholder')}
            maxLength={100}
            className="h-8 min-w-0 px-2 text-xs"
          />
        </div>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="sample-form-new-route" className="text-xs">
          {t('preferences.sampleForms.newRoute')}
        </Label>
        <RouteSelect
          id="sample-form-new-route"
          value={route}
          onChange={setRoute}
        />
      </div>
      {/* order, samples and status have nothing to set on a new form */}
      <span />
      <span />
      <span />
      <Button
        type="submit"
        size="sm"
        className="justify-self-end"
        disabled={!valid || create.isPending}
      >
        <Plus className="me-1 h-4 w-4" />
        {t('preferences.sampleForms.add')}
      </Button>
    </form>
  )
}
