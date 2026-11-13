import { Fragment, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { TableCell, TableRow } from '@/components/ui/table'
import {
  createHplcPrepRule,
  updateHplcPrepRule,
  type HplcPrepRuleIn,
  type HplcPrepRuleSaved,
  type Instrument,
  type PeptideRecord,
} from '@/lib/api'
import {
  DEFAULT_DILUENT,
  HPLC_DILUENTS,
  ruleText,
  type HplcPrepRule,
  type HplcPrepRuleStatus,
} from '@/lib/hplc-prep-rules'
import { HPLC_RUN_PARAM_DEFAULTS } from '@/lib/hplc-run-params'

/*
 * One line of the HPLC prep rules page, editable in place: its draft, the
 * catalog peptide search and the row itself. The page owns the list, the
 * order and the warnings.
 */

/** A row as typed: the numbers stay text until saved, so a stray entry is
 *  refused on the row instead of sent as null. A blank select is "". */
interface Draft {
  peptide_id: number | null
  min_mg: string
  max_mg: string
  target_conc_ug_ml: string
  blend_target_conc_ug_ml: string
  lead_component_id: number | null
  lead_priority: string
  floor_ug_ml: string
  diluent: string
  default_instrument_id: number | null
  status: HplcPrepRuleStatus
  note: string
  active: boolean
}

/** The decimal fields, with the label their cell and their refusal use. */
const NUMBER_FIELDS = [
  ['min_mg', 'Above mg'],
  ['max_mg', 'Up to mg'],
  ['target_conc_ug_ml', 'Target Conc (ug/mL)'],
  ['blend_target_conc_ug_ml', 'Target in a blend (ug/mL)'],
  ['floor_ug_ml', 'Floor (ug/mL)'],
] as const

type NumberKey = (typeof NUMBER_FIELDS)[number][0]

/** The concentrations: a typed one must be more than 0 (blank is the standard). */
const POSITIVE_FIELDS: readonly NumberKey[] = [
  'target_conc_ug_ml',
  'blend_target_conc_ug_ml',
  'floor_ug_ml',
]

/** A blend line has no blend target; only a blend line has a floor. */
const usedBy = (key: NumberKey, isBlend: boolean) =>
  isBlend ? key !== 'blend_target_conc_ug_ml' : key !== 'floor_ug_ml'

const RANK_LABEL = 'leads blends, rank'

const STATUS_TONE: Record<HplcPrepRuleStatus, string> = {
  trial:
    'border-amber-500/45 text-amber-700 dark:border-amber-400/50 dark:text-amber-300',
  validated:
    'border-teal-500/45 text-teal-700 dark:border-teal-400/50 dark:text-teal-300',
}

const text = (v: number | null | undefined) => (v == null ? '' : String(v))

function draftOf(r: HplcPrepRule | null): Draft {
  return {
    peptide_id: r?.peptide_id ?? null,
    min_mg: text(r?.min_mg),
    max_mg: text(r?.max_mg),
    target_conc_ug_ml: text(r?.target_conc_ug_ml),
    blend_target_conc_ug_ml: text(r?.blend_target_conc_ug_ml),
    lead_component_id: r?.lead_component_id ?? null,
    lead_priority: text(r?.lead_priority),
    floor_ug_ml: text(r?.floor_ug_ml),
    diluent: r?.diluent ?? '',
    default_instrument_id: r?.default_instrument_id ?? null,
    status: r?.status ?? 'trial',
    note: r?.note ?? '',
    active: r?.active ?? true,
  }
}

/** Blank is null (the standard); anything else must be a number. */
function numOf(t: string): number | null | undefined {
  const s = t.trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/** The draft as the API body, or why it cannot be sent. A field the line's
 *  kind does not use goes as null (a blend line has no blend target and no
 *  rank, any other line no lead and no floor), so a peptide switch never
 *  sends a stale one. A typed concentration of 0 or less is refused here in
 *  the sheet's words; the server makes every other check and its 400 text
 *  shows on the row. */
function bodyOf(d: Draft, isBlend: boolean): HplcPrepRuleIn | string {
  if (d.peptide_id === null) return 'Pick a peptide'
  const used = NUMBER_FIELDS.filter(([key]) => usedBy(key, isBlend))
  const bad = used.find(([key]) => numOf(d[key]) === undefined)
  if (bad) return `${bad[1]} must be a number`
  const notPositive = used.find(([key]) => {
    const n = numOf(d[key])
    return POSITIVE_FIELDS.includes(key) && n != null && n <= 0
  })
  if (notPositive) return `${notPositive[1]} must be more than 0`
  const rank = isBlend ? null : numOf(d.lead_priority)
  if (rank === undefined || (rank !== null && !Number.isInteger(rank)))
    return `${RANK_LABEL} must be a whole number`
  return {
    peptide_id: d.peptide_id,
    min_mg: numOf(d.min_mg) ?? null,
    max_mg: numOf(d.max_mg) ?? null,
    target_conc_ug_ml: numOf(d.target_conc_ug_ml) ?? null,
    blend_target_conc_ug_ml: isBlend
      ? null
      : (numOf(d.blend_target_conc_ug_ml) ?? null),
    lead_component_id: isBlend ? d.lead_component_id : null,
    lead_priority: rank,
    floor_ug_ml: isBlend ? (numOf(d.floor_ug_ml) ?? null) : null,
    diluent: d.diluent || null,
    default_instrument_id: d.default_instrument_id,
    status: d.status,
    note: d.note.trim() || null,
    active: d.active,
  }
}

/** The draft moved onto a newer server line: a field the user has not touched
 *  since the last sync (it still equals `from`) takes the new server value, a
 *  field the user edited keeps the user's text. So a colleague's change never
 *  shows stale, and Save never sends the old value back over it. */
function rebased(draft: Draft, from: Draft, to: Draft): Draft {
  return Object.fromEntries(
    Object.entries(draft).map(([key, value]) => [
      key,
      value === from[key as keyof Draft] ? to[key as keyof Draft] : value,
    ])
  ) as Draft
}

/** The PATCH body: only the fields that differ from the stored line; a
 *  cleared one goes as an explicit null. */
function changedFields(
  body: HplcPrepRuleIn,
  rule: HplcPrepRule
): Partial<HplcPrepRuleIn> {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) => rule[key as keyof HplcPrepRuleIn] !== value
    )
  ) as Partial<HplcPrepRuleIn>
}

/** The catalog peptide search: active peptides and blends (a blend has its
 *  own line, which names its lead). cmdk filters on `value`, so it carries
 *  the names. */
function PeptidePicker({
  label,
  peptides,
  disabled,
  onPick,
}: {
  label: string | null
  peptides: PeptideRecord[]
  disabled: boolean
  onPick: (id: number) => void
}) {
  const [open, setOpen] = useState(false)
  const options = peptides
    .filter(p => p.active)
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-label="Peptide"
          aria-expanded={open}
          disabled={disabled}
          className="h-8 w-44 justify-between font-normal"
        >
          <span className="truncate">{label ?? 'Pick a peptide'}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search the catalog…" />
          <CommandList>
            <CommandEmpty>No matching peptide.</CommandEmpty>
            {options.map(p => (
              <CommandItem
                key={p.id}
                value={`${p.name} ${p.abbreviation} #${p.id}`}
                onSelect={() => {
                  onPick(p.id)
                  setOpen(false)
                }}
              >
                {p.name}
                <span className="ml-auto text-xs text-muted-foreground">
                  {p.abbreviation}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** One line, editable in place: Save sends the changed fields (a new line,
 *  all of them); the server's 400 text shows under the row until the next
 *  save, its warnings as chips. A blend line picks its lead from the blend's
 *  components and sets the floor; any other line takes a rank for leading
 *  the blends it is in. */
export function RuleRow({
  n,
  rule,
  peptides,
  instruments,
  warnings,
  canUp,
  canDown,
  moving,
  onMove,
  onSaved,
  onCancel,
}: {
  n: number | null
  rule: HplcPrepRule | null
  peptides: PeptideRecord[]
  instruments: Instrument[]
  warnings: string[]
  canUp: boolean
  canDown: boolean
  moving: boolean
  onMove: (by: -1 | 1) => void
  onSaved: (saved: HplcPrepRuleSaved) => void
  onCancel?: () => void
}) {
  const [draft, setDraft] = useState(() => draftOf(rule))
  // The line the draft was last synced with. The list is rewritten from the
  // server on every Move and every save, so `rule` can change under an
  // unsaved draft; rebase it (setting state in render is React's pattern for
  // state that follows a prop).
  const [base, setBase] = useState(rule)
  if (rule !== base) {
    setBase(rule)
    setDraft(rebased(draft, draftOf(base), draftOf(rule)))
  }
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dirty =
    rule === null || JSON.stringify(draft) !== JSON.stringify(draftOf(rule))
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft(d => ({ ...d, [key]: value }))
  const picked = peptides.find(p => p.id === draft.peptide_id)
  const own = rule && rule.peptide_id === draft.peptide_id ? rule : null
  const peptideName =
    picked?.name ??
    own?.peptide_name ??
    (draft.peptide_id === null ? null : `#${draft.peptide_id}`)
  const isBlend = picked?.is_blend ?? own?.peptide_is_blend ?? false
  // The blend's components, and the line's own lead if the catalog no
  // longer lists it there.
  const leads = (picked?.components ?? []).map(c => ({
    id: c.id,
    name: c.name,
  }))
  if (
    draft.lead_component_id !== null &&
    !leads.some(c => c.id === draft.lead_component_id)
  )
    leads.push({
      id: draft.lead_component_id,
      name:
        (own?.lead_component_id === draft.lead_component_id
          ? own.lead_component_name
          : null) ?? `#${draft.lead_component_id}`,
    })
  // Active instruments, and the line's own if it was retired since.
  const machines = instruments
    .filter(i => i.active || i.id === draft.default_instrument_id)
    .map(i => ({ id: i.id, name: i.active ? i.name : `${i.name} (retired)` }))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (
    draft.default_instrument_id !== null &&
    !machines.some(i => i.id === draft.default_instrument_id)
  )
    machines.push({
      id: draft.default_instrument_id,
      name:
        (rule?.default_instrument_id === draft.default_instrument_id
          ? rule.default_instrument_name
          : null) ?? `#${draft.default_instrument_id}`,
    })

  async function save() {
    const body = bodyOf(draft, isBlend)
    if (typeof body === 'string') {
      setError(body)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = rule
        ? await updateHplcPrepRule(rule.id, changedFields(body, rule))
        : await createHplcPrepRule(body)
      if (rule) setDraft(draftOf(saved.rule))
      onSaved(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const numberInput = (key: NumberKey, label: string, placeholder: string) => (
    <Input
      aria-label={label}
      inputMode="decimal"
      placeholder={placeholder}
      value={draft[key]}
      onChange={e => set(key, e.target.value)}
      className="h-8 w-20 text-right font-mono"
    />
  )

  return (
    <Fragment>
      <TableRow
        data-rule={rule?.id ?? 'new'}
        className={draft.active ? '' : 'opacity-60'}
      >
        <TableCell
          title={rule ? ruleText(rule) : undefined}
          className="font-mono text-xs text-muted-foreground"
        >
          {n ?? 'new'}
        </TableCell>
        <TableCell>
          <PeptidePicker
            label={peptideName}
            peptides={peptides}
            disabled={saving}
            onPick={id => set('peptide_id', id)}
          />
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-1">
            {numberInput('min_mg', 'Above mg', 'above')}
            {numberInput('max_mg', 'Up to mg', 'up to')}
          </div>
        </TableCell>
        <TableCell>
          {numberInput(
            'target_conc_ug_ml',
            'Target Conc (ug/mL)',
            String(HPLC_RUN_PARAM_DEFAULTS.default_target_ug_ml)
          )}
        </TableCell>
        <TableCell>
          {isBlend ? (
            <span
              title="not set on a blend line"
              className="font-mono text-muted-foreground"
            >
              -
            </span>
          ) : (
            numberInput(
              'blend_target_conc_ug_ml',
              'Target in a blend (ug/mL)',
              'as target'
            )
          )}
        </TableCell>
        <TableCell>
          {isBlend ? (
            <NativeSelect
              aria-label="Lead"
              value={draft.lead_component_id ?? ''}
              onChange={e =>
                set(
                  'lead_component_id',
                  e.target.value ? Number(e.target.value) : null
                )
              }
              className="h-8 w-36 py-1 text-xs"
            >
              <NativeSelectOption value="">
                by the usual rule
              </NativeSelectOption>
              {leads.map(c => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {c.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : (
            <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
              <Input
                inputMode="numeric"
                placeholder="unranked"
                title="blank = never preferred as the lead"
                value={draft.lead_priority}
                onChange={e => set('lead_priority', e.target.value)}
                className="h-8 w-12 text-right font-mono text-sm text-foreground"
              />
              {RANK_LABEL}
            </label>
          )}
        </TableCell>
        <TableCell>
          <NativeSelect
            aria-label="Diluent"
            value={draft.diluent}
            onChange={e => set('diluent', e.target.value)}
            className="h-8 w-40 py-1 text-xs"
          >
            <NativeSelectOption value="">{`${DEFAULT_DILUENT} (standard)`}</NativeSelectOption>
            {HPLC_DILUENTS.map(d => (
              <NativeSelectOption key={d} value={d}>
                {d}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </TableCell>
        <TableCell>
          {isBlend ? (
            numberInput(
              'floor_ug_ml',
              'Floor (ug/mL)',
              String(HPLC_RUN_PARAM_DEFAULTS.floor_ug_ml)
            )
          ) : (
            <span
              title="set on the blend's own line"
              className="font-mono text-muted-foreground"
            >
              -
            </span>
          )}
        </TableCell>
        <TableCell>
          <NativeSelect
            aria-label="Instrument"
            value={draft.default_instrument_id ?? ''}
            onChange={e =>
              set(
                'default_instrument_id',
                e.target.value ? Number(e.target.value) : null
              )
            }
            className="h-8 w-36 py-1 text-xs"
          >
            <NativeSelectOption value="">any instrument</NativeSelectOption>
            {machines.map(i => (
              <NativeSelectOption key={i.id} value={i.id}>
                {i.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </TableCell>
        <TableCell>
          <NativeSelect
            aria-label="Status"
            value={draft.status}
            onChange={e => set('status', e.target.value as HplcPrepRuleStatus)}
            className={`h-8 w-28 py-1 text-xs font-semibold ${STATUS_TONE[draft.status]}`}
          >
            <NativeSelectOption value="trial">trial</NativeSelectOption>
            <NativeSelectOption value="validated">validated</NativeSelectOption>
          </NativeSelect>
        </TableCell>
        <TableCell>
          <Input
            aria-label="Note"
            value={draft.note}
            onChange={e => set('note', e.target.value)}
            placeholder="why: run result, date"
            className="h-8 w-48 text-xs"
          />
        </TableCell>
        <TableCell>
          <Switch
            aria-label="Active"
            checked={draft.active}
            onCheckedChange={v => set('active', v)}
          />
        </TableCell>
        <TableCell className="whitespace-nowrap">
          {rule && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Move up"
                title="Move up"
                disabled={!canUp || moving}
                onClick={() => onMove(-1)}
                className="h-7 w-7"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Move down"
                title="Move down"
                disabled={!canDown || moving}
                onClick={() => onMove(1)}
                className="h-7 w-7"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </TableCell>
        <TableCell className="whitespace-nowrap">
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void save()}
            className="h-8"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
          {onCancel && (
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={onCancel}
              className="ml-1 h-8"
            >
              Cancel
            </Button>
          )}
        </TableCell>
      </TableRow>
      {(error || warnings.length > 0) && (
        <TableRow className="hover:bg-transparent">
          <TableCell />
          <TableCell colSpan={13} className="pt-0">
            {error && (
              <p
                role="alert"
                className="text-xs font-semibold text-red-600 dark:text-red-400"
              >
                Not saved: {error}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {warnings.map(w => (
                <span
                  key={w}
                  className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:border-amber-400/45 dark:bg-amber-400/15 dark:text-amber-300"
                >
                  {w}
                </span>
              ))}
            </div>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  )
}
