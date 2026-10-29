import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSampleForms } from '@/services/sample-forms'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { iconKey, type SampleFormIconKey } from '@/lib/sample-form-icons'
import { cn } from '@/lib/utils'

// Drawn on lucide's 24px grid in its line style (round caps, currentColor), so
// they sit beside lucide icons. Solid fills are the contents: the powder cake,
// the liquid, the pen's dose window.
const fill = { fill: 'currentColor', stroke: 'none' } as const

const VIAL = (
  <>
    <path d="M9 2.5h6V5H9z" />
    <path d="M9.5 5v1.2c0 .9-3.5 1.4-3.5 3.3V20a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 20V9.5c0-1.9-3.5-2.4-3.5-3.3V5" />
  </>
)

const DRAWINGS: Record<SampleFormIconKey, ReactNode> = {
  powder_vial: (
    <>
      {VIAL}
      <path
        d="M7.9 17.4c1.4-.8 2.8-.4 4.1-.1s2.7.4 4.1-.2v2.4a.6.6 0 0 1-.6.6H8.5a.6.6 0 0 1-.6-.6z"
        {...fill}
        fillOpacity={0.6}
      />
    </>
  ),
  liquid_vial: (
    <>
      {VIAL}
      <path
        d="M7.9 12.6c1.4-.7 2.7.7 4.1 0s2.7.7 4.1 0v6.9a.6.6 0 0 1-.6.6H8.5a.6.6 0 0 1-.6-.6z"
        {...fill}
        fillOpacity={0.28}
      />
      <path d="M7.9 12.6c1.4-.7 2.7.7 4.1 0s2.7.7 4.1 0" strokeWidth={1.25} />
    </>
  ),
  pen: (
    <g transform="rotate(-45 12 12)">
      <rect x="5" y="9.75" width="12" height="4.5" rx="1.5" />
      <rect x="17" y="10.6" width="2.6" height="2.8" rx=".6" />
      <path d="M19.6 12h1.6" />
      <rect x="3.2" y="11" width="1.8" height="2" rx=".4" />
      <path d="M3.2 12H1.2" />
      <rect
        x="8.5"
        y="11.2"
        width="4"
        height="1.6"
        rx=".5"
        {...fill}
        fillOpacity={0.4}
      />
    </g>
  ),
  nasal_spray: (
    <>
      <rect x="7.5" y="12" width="9" height="9.5" rx="2" />
      <rect x="5" y="10.25" width="14" height="1.75" rx=".875" />
      <path d="M10.25 10.25l.65-4.65a1.1 1.1 0 0 1 2.2 0l.65 4.65" />
      <path
        d="M9.2 16.5h5.6v3.1a.7.7 0 0 1-.7.7H9.9a.7.7 0 0 1-.7-.7z"
        {...fill}
        fillOpacity={0.28}
      />
      <circle cx="9.3" cy="3.2" r=".8" {...fill} />
      <circle cx="12" cy="2" r=".8" {...fill} />
      <circle cx="14.7" cy="3.2" r=".8" {...fill} />
    </>
  ),
  capsule: (
    <g transform="rotate(-45 12 12)">
      <path
        d="M12 8.25h5.25a3.75 3.75 0 0 1 0 7.5H12z"
        {...fill}
        fillOpacity={0.4}
      />
      <rect x="3" y="8.25" width="18" height="7.5" rx="3.75" />
      <path d="M12 8.25v7.5" />
    </g>
  ),
  tablet: (
    <>
      <ellipse cx="12" cy="10" rx="8.5" ry="4.75" />
      <path d="M3.5 10v3.5c0 2.6 3.8 4.75 8.5 4.75s8.5-2.15 8.5-4.75V10" />
      <path d="M7 10h10" />
    </>
  ),
  syringe: (
    <g transform="rotate(-45 12 12)">
      <rect x="6" y="9.75" width="10" height="4.5" rx=".75" />
      <rect
        x="6.6"
        y="10.6"
        width="4.4"
        height="2.8"
        {...fill}
        fillOpacity={0.3}
      />
      <path d="M16 8.5v7" />
      <path d="M16 12h4" />
      <path d="M20.5 10v4" />
      <path d="M6 12H1.5" />
    </g>
  ),
  other: (
    <>
      <rect x="6" y="7.5" width="12" height="14" rx="2" />
      <path d="M7.5 3.5h9v4h-9z" />
      <path d="M9 13h6" />
    </>
  ),
}

/** A dosage form's icon. Decorative: it always sits beside the form's name. */
export function SampleFormIcon({
  icon,
  className,
}: {
  icon: string | null | undefined
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon={iconKey(icon)}
      className={cn('size-4 shrink-0', className)}
    >
      {DRAWINGS[iconKey(icon)]}
    </svg>
  )
}

/** The icon of the form with this id, for surfaces that hold only the id (a
 *  form-tier spec row). Draws nothing until the cached form list arrives. */
export function SampleFormIconById({
  id,
  className,
}: {
  id: number
  className?: string
}) {
  const { data: forms } = useSampleForms()
  const form = forms?.find(f => f.id === id)
  return form ? <SampleFormIcon icon={form.icon} className={className} /> : null
}

/** The hover card behind a form mark. Pure, so it renders without a query. */
export function SampleFormCard({
  name,
  routeLabel,
  active,
}: {
  name: string
  routeLabel: string
  active: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5 p-3 font-mono text-xs">
      <div className="border-b border-primary-foreground/20 pb-1.5 font-semibold">
        {name}
      </div>
      <div>
        <span className="opacity-60">Route:</span> {routeLabel}
        {!active && <span className="opacity-60"> (inactive)</span>}
      </div>
    </div>
  )
}

/** A sample's form at a glance on list pages (order status, customer status,
 *  vial board, COA Explorer): the icon, with the form's name on hover. Draws
 *  nothing for a sample without a form or before the form list arrives. */
export function SampleFormMark({
  formId,
  className,
}: {
  formId: number | null | undefined
  className?: string
}) {
  return formId == null ? null : (
    <SampleFormMarkFor formId={formId} className={className} />
  )
}

function SampleFormMarkFor({
  formId,
  className,
}: {
  formId: number
  className?: string
}) {
  const { t } = useTranslation()
  const { data: forms } = useSampleForms()
  const form = forms?.find(f => f.id === formId)
  if (!form) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={`Form: ${form.name}`}
          className="inline-flex shrink-0 text-muted-foreground"
        >
          <SampleFormIcon
            icon={form.icon}
            className={cn('size-3.5', className)}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs p-0">
        <SampleFormCard
          name={form.name}
          routeLabel={t(`preferences.sampleForms.route.${form.route}`)}
          active={form.active}
        />
      </TooltipContent>
    </Tooltip>
  )
}
