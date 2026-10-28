import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSampleForms, useSetSampleForm } from '@/services/sample-forms'
import { SampleFormIcon } from '@/components/common/SampleFormIcon'
import { cn } from '@/lib/utils'

/**
 * Inline dosage-form picker for one sample (sample-forms spec).
 *
 * Callers render it only for form-eligible samples (`sample_form_eligible`);
 * a Bacteriostatic Water sample has no form and the server rejects the write.
 *
 * `valueId` may be null for an eligible sample (a row born before its type was
 * known; the next backend boot fills it in), which renders the placeholder.
 * An inactive current form stays visible as a disabled, selected item so the
 * control never shows blank, but it cannot be re-picked once changed away.
 *
 * `onChanged` is for surfaces that keep the lookup in local state (the wizard,
 * sample details), where the mutation's cache invalidation alone leaves them
 * stale.
 */
export function SampleFormSelect({
  sampleId,
  valueId,
  valueName,
  onChanged,
  compact = false,
  className,
  ariaLabel = 'Form',
}: {
  /** Business sample id (e.g. P-0141), the key the PATCH route matches on. */
  sampleId: string
  valueId: number | null
  valueName: string | null
  onChanged?: () => void
  compact?: boolean
  className?: string
  ariaLabel?: string
}) {
  const { data: forms } = useSampleForms()
  const set = useSetSampleForm()
  const current = forms?.find(f => f.id === valueId)
  const options = (forms ?? []).filter(f => f.active || f.id === valueId)
  const name =
    valueId == null
      ? null
      : current
        ? `${current.name}${current.active ? '' : ' (inactive)'}`
        : valueName
  // Before the form list arrives the name comes from the lookup and the icon
  // is the generic one; the list fills it in a moment later.
  const label = name && (
    <span className="flex min-w-0 items-center gap-1.5">
      <SampleFormIcon icon={current?.icon} />
      <span className="truncate">{name}</span>
    </span>
  )
  return (
    <Select
      value={valueId == null ? '' : String(valueId)}
      disabled={!forms || set.isPending}
      onValueChange={v =>
        set.mutate(
          { sampleId, sampleFormId: Number(v) },
          { onSuccess: () => onChanged?.() }
        )
      }
    >
      <SelectTrigger
        className={cn(compact ? 'h-7 text-xs' : 'h-8 text-sm', className)}
        aria-label={ariaLabel}
      >
        {/* Explicit children: the closed trigger must not depend on the item
            list being mounted. Radix shows `placeholder` instead whenever the
            value is empty. */}
        <SelectValue
          placeholder={
            <span className="text-muted-foreground">Select form</span>
          }
        >
          {label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map(f => (
          <SelectItem key={f.id} value={String(f.id)} disabled={!f.active}>
            <SampleFormIcon icon={f.icon} />
            {f.name}
            {!f.active && ' (inactive)'}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
