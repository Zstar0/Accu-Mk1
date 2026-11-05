import type { ReactNode } from 'react'
import { useQueries } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { listServiceSpecs, type AnalysisServiceRecord } from '@/lib/api'
import { cn } from '@/lib/utils'
import { FootnoteListEditor } from './FootnoteListEditor'
import {
  COA_FIELD_ROWS,
  COA_MACRO_HINT,
  buildPreview,
  draftErrors,
  guardMessage,
  heldNote,
  memberRuleStatus,
  setChoice,
  type CoaDefaults,
  type CoaField,
  type FieldChoice,
  type Footnote,
  type PreviewPiece,
  type RuleStatus,
  type VariantDraft,
} from './coa-variant-logic'

const AMBER = 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
const GREEN = 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
const MUTED = 'bg-muted text-muted-foreground'

const GUARD_TONE: Record<RuleStatus['kind'], string> = {
  held: AMBER,
  ok: GREEN,
  loading: MUTED,
  unknown: MUTED,
}

const CHOICES: { value: FieldChoice; label: string }[] = [
  { value: 'default', label: 'Same as default' },
  { value: 'custom', label: 'Custom' },
  { value: 'off', label: 'Leave off' },
]

const NOTE_BOX =
  'rounded-md bg-muted/50 px-2.5 py-1.5 text-sm text-muted-foreground'

export interface CoaVariantEditorProps {
  draft: VariantDraft
  onChange: (next: VariantDraft) => void
  defaults: CoaDefaults
  savedMemberIds: number[]
  membersLoading: boolean
  services: Pick<AnalysisServiceRecord, 'id' | 'title'>[]
  dirty: boolean
  saving: boolean
  onSave: () => void
  onCancel: () => void
  /** Existing versions only. */
  onStop?: () => void
  onAddRule: (serviceId: number) => void
}

/** Where a piece of text comes from: the Default, this form's version, or held. */
function SourceTag({ tag, formName }: { tag: string; formName: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-normal text-muted-foreground',
        tag === 'Default, held' && `border-transparent ${AMBER}`,
        tag === formName && 'border-transparent bg-primary/10 text-primary'
      )}
    >
      {tag}
    </Badge>
  )
}

function FootnoteLines({
  rows,
  lastTag,
}: {
  rows: Footnote[]
  lastTag?: ReactNode
}) {
  return rows.map((row, index) => (
    <p key={index}>
      <span className="font-medium">{row.label}</span> {row.text}
      {index === rows.length - 1 && lastTag && <> {lastTag}</>}
    </p>
  ))
}

function GuardLine({
  status,
  formName,
  onAddRule,
}: {
  status: RuleStatus
  formName: string
  onAddRule: (serviceId: number) => void
}) {
  return (
    <div
      data-testid="coa-variant-guard"
      className={cn(
        'flex gap-2 rounded-md px-3 py-2 text-sm',
        GUARD_TONE[status.kind]
      )}
    >
      {status.kind === 'ok' && (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      {status.kind === 'held' && (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <div className="space-y-1">
        <p>{guardMessage(status, formName)}</p>
        {status.kind === 'held' && (
          <div className="flex flex-wrap gap-x-3">
            {status.missing.map(({ serviceId, name }) => (
              <Button
                key={serviceId}
                type="button"
                variant="link"
                className="h-auto p-0 text-inherit underline"
                onClick={() => onAddRule(serviceId)}
              >
                {status.missing.length > 1
                  ? `Add the rule: ${name}`
                  : 'Add the rule'}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function InheritedText({
  field,
  defaults,
  formName,
}: {
  field: CoaField
  defaults: CoaDefaults
  formName: string
}) {
  const value =
    field === 'coa_section_title'
      ? defaults.coa_section_title || defaults.name
      : defaults[field]
  return (
    <div className={cn(NOTE_BOX, 'flex items-start gap-2')}>
      <SourceTag tag="Default" formName={formName} />
      <div className="min-w-0 space-y-1">
        {!value?.length ? (
          <p className="italic">The Default is blank, so nothing prints</p>
        ) : typeof value === 'string' ? (
          <p>{value}</p>
        ) : (
          <FootnoteLines rows={value} />
        )}
      </div>
    </div>
  )
}

function CustomInput({
  field,
  label,
  draft,
  onChange,
}: {
  field: CoaField
  label: string
  draft: VariantDraft
  onChange: (next: VariantDraft) => void
}) {
  if (field === 'coa_footnotes') {
    return (
      <FootnoteListEditor
        value={draft.footnotes ?? []}
        onChange={footnotes => onChange({ ...draft, footnotes })}
      />
    )
  }
  const value = draft.texts[field] ?? ''
  const setText = (text: string) =>
    onChange({ ...draft, texts: { ...draft.texts, [field]: text } })
  return field === 'coa_section_title' || field === 'coa_basis_note' ? (
    <Input
      aria-label={label}
      maxLength={200}
      value={value}
      onChange={e => setText(e.target.value)}
    />
  ) : (
    <Textarea
      aria-label={label}
      value={value}
      onChange={e => setText(e.target.value)}
    />
  )
}

function PreviewLine({
  piece,
  formName,
  prefix,
}: {
  piece: PreviewPiece
  formName: string
  prefix?: string
}) {
  return (
    <p>
      {piece.text ? (
        <>
          {prefix && <span className="text-muted-foreground">{prefix} </span>}
          <span>{piece.text}</span>
        </>
      ) : (
        <span className="italic text-muted-foreground">{piece.missing}</span>
      )}{' '}
      <SourceTag tag={piece.tag} formName={formName} />
    </p>
  )
}

export function CoaVariantEditor({
  draft,
  onChange,
  defaults,
  savedMemberIds,
  membersLoading,
  services,
  dirty,
  saving,
  onSave,
  onCancel,
  onStop,
  onAddRule,
}: CoaVariantEditorProps) {
  const formName = draft.formName
  const nameOf = (id: number) =>
    services.find(s => s.id === id)?.title ?? `Service ${id}`

  // Same key as ServiceSpecsSection and the other readers of a service's rules,
  // so a rule added there is seen here.
  const specs = useQueries({
    queries: savedMemberIds.map(id => ({
      queryKey: ['analysis-services', id, 'specs'],
      queryFn: () => listServiceSpecs(id),
      // The guard line must not stay green on a rule removed since the last look.
      staleTime: 0,
    })),
  })
  const status = memberRuleStatus(
    draft.formId,
    savedMemberIds.map((id, index) => ({
      serviceId: id,
      name: nameOf(id),
      rules: specs[index]?.data,
      failed: specs[index]?.isError ?? false,
    })),
    membersLoading
  )

  const errors = draftErrors(draft)
  const held = heldNote(status)
  const preview = buildPreview(draft, defaults, status)
  const footnotesTag = (
    <SourceTag tag={preview.footnotes.tag} formName={formName} />
  )
  const limitsOverridden =
    draft.choices.coa_basis_note !== 'default' ||
    draft.choices.coa_footnotes !== 'default'

  return (
    <div className="space-y-3">
      {limitsOverridden && (
        <GuardLine status={status} formName={formName} onAddRule={onAddRule} />
      )}
      <p
        data-testid="coa-variant-macro-hint"
        className="text-xs text-muted-foreground"
      >
        {COA_MACRO_HINT}
      </p>

      <div>
        {COA_FIELD_ROWS.map(({ field, label, limits, canLeaveOff }) => {
          const choice = draft.choices[field]
          return (
            <div
              key={field}
              data-testid={`coa-variant-row-${field}`}
              className="space-y-1.5 border-t py-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-sm font-medium">{label}</span>
                  {limits && (
                    <span className="text-[11px] text-muted-foreground">
                      describes the limits
                    </span>
                  )}
                </div>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  aria-label={label}
                  value={choice}
                  onValueChange={v => {
                    if (v) {
                      onChange(
                        setChoice(draft, field, v as FieldChoice, defaults)
                      )
                    }
                  }}
                >
                  {CHOICES.filter(c => c.value !== 'off' || canLeaveOff).map(
                    c => (
                      <ToggleGroupItem
                        key={c.value}
                        value={c.value}
                        aria-label={`${label}: ${c.label}`}
                        className="flex-none px-2.5 text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                      >
                        {c.label}
                      </ToggleGroupItem>
                    )
                  )}
                </ToggleGroup>
              </div>

              {choice === 'default' && (
                <InheritedText
                  field={field}
                  defaults={defaults}
                  formName={formName}
                />
              )}
              {choice === 'custom' && (
                <>
                  <CustomInput
                    field={field}
                    label={label}
                    draft={draft}
                    onChange={onChange}
                  />
                  {errors[field] && (
                    <p className="text-xs text-destructive">{errors[field]}</p>
                  )}
                </>
              )}
              {choice === 'off' && (
                <p className={cn(NOTE_BOX, 'italic')}>
                  Not printed on {formName} COAs
                </p>
              )}
              {limits && choice !== 'default' && held && (
                <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  {held}
                </p>
              )}
            </div>
          )
        })}
      </div>

      <div
        data-testid="coa-variant-preview"
        className="space-y-2 rounded-md border bg-muted/30 p-3"
      >
        <p className="text-xs text-muted-foreground">
          What prints on a {formName} COA
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
          <div className="text-sm font-medium">
            <PreviewLine piece={preview.title} formName={formName} />
          </div>
          <div className="text-xs">
            <PreviewLine piece={preview.basis} formName={formName} />
          </div>
        </div>
        <table className="w-full text-xs">
          <tbody>
            {savedMemberIds.map(id => (
              <tr key={id} className="border-b border-border/50">
                <td className="py-1">{nameOf(id)}</td>
                <td className="py-1 text-right text-muted-foreground">-</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="space-y-1 text-xs">
          <PreviewLine
            piece={preview.method}
            formName={formName}
            prefix="Method:"
          />
          <PreviewLine
            piece={preview.prep}
            formName={formName}
            prefix="Sample prep:"
          />
        </div>
        {preview.footnotes.items.length > 0 ? (
          <div
            data-testid="coa-variant-preview-footnotes"
            className="space-y-1 rounded-md border px-2.5 py-1.5 text-xs"
          >
            <FootnoteLines
              rows={preview.footnotes.items}
              lastTag={footnotesTag}
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            no footnotes {footnotesTag}
          </p>
        )}
        {preview.macroNote && (
          <p className="text-xs text-muted-foreground">
            {"{lod} fills in from each sample's results"}
          </p>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
        {onStop && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={saving}
            onClick={onStop}
          >
            Stop using this version
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || saving || Object.keys(errors).length > 0}
          onClick={onSave}
        >
          Save {formName} text
        </Button>
      </div>
    </div>
  )
}
