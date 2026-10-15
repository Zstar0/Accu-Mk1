import { Fragment, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  ListOrdered,
  Loader2,
  Plus,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  createEndoPrepRule,
  getPeptides,
  listConsumables,
  reorderEndoPrepRules,
  updateEndoPrepRule,
  type ConsumableType,
  type EndoPrepRuleIn,
  type EndoPrepRuleOut,
  type EndoPrepRuleSaved,
  type PeptideRecord,
} from '@/lib/api'
import { fmt } from '@/lib/endo-prep'
import type { EndoPrepRuleStatus } from '@/lib/endo-prep-rules'
import {
  ENDO_PREP_RULES_KEY,
  useEndoPrepRules,
} from '@/services/endo-prep-rules'

/** A row as typed: the numbers stay text until saved, so a stray entry is
 *  refused on the row instead of sent as null. */
interface Draft {
  peptide_id: number | null
  min_mg: string
  max_mg: string
  total_dilution: string
  step1_ratio: string
  cartridge_type_id: number | null
  status: EndoPrepRuleStatus
  note: string
  active: boolean
}

const NUMBER_FIELDS = [
  ['min_mg', 'Above mg'],
  ['max_mg', 'Up to mg'],
  ['total_dilution', 'Total 1:N'],
  ['step1_ratio', 'Step 1 1:N'],
] as const

const STATUS_TONE: Record<EndoPrepRuleStatus, string> = {
  trial:
    'border-amber-500/45 text-amber-700 dark:border-amber-400/50 dark:text-amber-300',
  validated:
    'border-teal-500/45 text-teal-700 dark:border-teal-400/50 dark:text-teal-300',
}

const text = (v: number | null | undefined) => (v == null ? '' : String(v))

function draftOf(r: EndoPrepRuleOut | null): Draft {
  return {
    peptide_id: r?.peptide_id ?? null,
    min_mg: text(r?.min_mg),
    max_mg: text(r?.max_mg),
    total_dilution: text(r?.total_dilution),
    step1_ratio: text(r?.step1_ratio),
    cartridge_type_id: r?.cartridge_type_id ?? null,
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

/** The draft as the API body, or why it cannot be sent. The server makes
 *  every other check (spec 3) and its 400 text shows on the row. */
function bodyOf(d: Draft): EndoPrepRuleIn | string {
  if (d.peptide_id === null) return 'Pick a peptide'
  const bad = NUMBER_FIELDS.find(([key]) => numOf(d[key]) === undefined)
  if (bad) return `${bad[1]} must be a number`
  return {
    peptide_id: d.peptide_id,
    min_mg: numOf(d.min_mg) ?? null,
    max_mg: numOf(d.max_mg) ?? null,
    total_dilution: numOf(d.total_dilution) ?? null,
    step1_ratio: numOf(d.step1_ratio) ?? null,
    cartridge_type_id: d.cartridge_type_id,
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

/** The PATCH body: only the fields that differ from the stored line. */
function changedFields(
  body: EndoPrepRuleIn,
  rule: EndoPrepRuleOut
): Partial<EndoPrepRuleIn> {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) => rule[key as keyof EndoPrepRuleIn] !== value
    )
  ) as Partial<EndoPrepRuleIn>
}

/** The catalog peptide search: active single peptides only (a blend never
 *  matches, spec D2). cmdk filters on `value`, so it carries the names. */
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
    .filter(p => p.active && !p.is_blend)
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
 *  save, its warnings as chips. */
function RuleRow({
  n,
  rule,
  peptides,
  cartridges,
  warnings,
  canUp,
  canDown,
  moving,
  onMove,
  onSaved,
  onCancel,
}: {
  n: number | null
  rule: EndoPrepRuleOut | null
  peptides: PeptideRecord[]
  cartridges: ConsumableType[]
  warnings: string[]
  canUp: boolean
  canDown: boolean
  moving: boolean
  onMove: (by: -1 | 1) => void
  onSaved: (saved: EndoPrepRuleSaved) => void
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
  const peptideName =
    peptides.find(p => p.id === draft.peptide_id)?.name ??
    (rule && rule.peptide_id === draft.peptide_id ? rule.peptide_name : null) ??
    (draft.peptide_id === null ? null : `#${draft.peptide_id}`)
  // Active endotoxin cartridges, and the line's own if it was retired since.
  const options = cartridges
    .filter(
      c =>
        c.kind === 'endo_cartridge' &&
        (c.active || c.id === draft.cartridge_type_id)
    )
    .sort(
      (a, b) =>
        Number(b.specs.sensitivity_eu_ml) - Number(a.specs.sensitivity_eu_ml)
    )

  async function save() {
    const body = bodyOf(draft)
    if (typeof body === 'string') {
      setError(body)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = rule
        ? await updateEndoPrepRule(rule.id, changedFields(body, rule))
        : await createEndoPrepRule(body)
      if (rule) setDraft(draftOf(saved.rule))
      onSaved(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Fragment>
      <TableRow
        data-rule={rule?.id ?? 'new'}
        className={draft.active ? '' : 'opacity-60'}
      >
        <TableCell className="font-mono text-xs text-muted-foreground">
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
        {NUMBER_FIELDS.map(([key, label]) => (
          <TableCell key={key}>
            <Input
              aria-label={label}
              inputMode="decimal"
              placeholder={key === 'min_mg' || key === 'max_mg' ? '-' : 'std'}
              value={draft[key]}
              onChange={e => set(key, e.target.value)}
              className="h-8 w-20 text-right font-mono"
            />
          </TableCell>
        ))}
        <TableCell>
          <NativeSelect
            aria-label="Cartridge"
            value={draft.cartridge_type_id ?? ''}
            onChange={e =>
              set(
                'cartridge_type_id',
                e.target.value ? Number(e.target.value) : null
              )
            }
            className="h-8 w-40 py-1 text-xs"
          >
            <NativeSelectOption value="">usual cartridge</NativeSelectOption>
            {options.map(c => (
              <NativeSelectOption key={c.id} value={c.id}>
                {`${fmt(Number(c.specs.sensitivity_eu_ml))} · ${c.name}${c.active ? '' : ' (retired)'}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </TableCell>
        <TableCell>
          <NativeSelect
            aria-label="Status"
            value={draft.status}
            onChange={e => set('status', e.target.value as EndoPrepRuleStatus)}
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
            placeholder="why: PPC result, date"
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
          <TableCell colSpan={10} className="pt-0">
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

/**
 * The 2 mL prep rules (slice 5, spec 9): per catalog peptide and weight
 * band, the total, the step 1 ratio and the cartridge a 2 mL row defaults
 * to. Editable in place; the order breaks ties between lines (spec 4). A
 * row that is printed, has a result or whose worksheet completed keeps the
 * line it locked to; edits here reach only rows that are not locked.
 */
export function EndoPrepRulesPage() {
  const queryClient = useQueryClient()
  const { data: rules = [], isLoading, error } = useEndoPrepRules()
  const { data: peptides = [] } = useQuery({
    queryKey: ['peptides'],
    queryFn: () => getPeptides(),
    staleTime: 5 * 60 * 1000,
  })
  const { data: cartridges = [] } = useQuery({
    queryKey: ['consumables', 'endo_cartridge'],
    queryFn: () => listConsumables({ kind: 'endo_cartridge' }),
    staleTime: 5 * 60 * 1000,
  })
  const [adding, setAdding] = useState(false)
  const [warnings, setWarnings] = useState<Record<number, string[]>>({})
  const [moving, setMoving] = useState(false)
  const trial = rules.filter(r => r.status === 'trial').length

  function saved({ rule, warnings: w }: EndoPrepRuleSaved) {
    queryClient.setQueryData<EndoPrepRuleOut[]>(ENDO_PREP_RULES_KEY, list =>
      list?.some(r => r.id === rule.id)
        ? list.map(r => (r.id === rule.id ? rule : r))
        : [...(list ?? []), rule]
    )
    setWarnings(prev => ({ ...prev, [rule.id]: w }))
  }

  async function move(i: number, by: -1 | 1) {
    const ids = rules.map(r => r.id)
    const [id] = ids.splice(i, 1)
    if (id === undefined) return
    ids.splice(i + by, 0, id)
    setMoving(true)
    try {
      queryClient.setQueryData(
        ENDO_PREP_RULES_KEY,
        await reorderEndoPrepRules(ids)
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reorder failed')
    } finally {
      setMoving(false)
    }
  }

  const rowProps = { peptides, cartridges, moving, onSaved: saved }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ListOrdered className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Endotoxin prep rules</h1>
            <p className="text-sm text-muted-foreground">
              The 2 mL prep per catalog peptide and weight band. A blank value
              keeps the standard. A row keeps the line it locked to at print,
              its first result or completion; Re-apply on the worksheet moves it
              on.
            </p>
          </div>
        </div>
        <Button onClick={() => setAdding(true)} disabled={adding}>
          <Plus className="mr-1 h-4 w-4" />
          Add rule
        </Button>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 py-3">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <span className="text-sm text-destructive">{error.message}</span>
          </CardContent>
        </Card>
      )}

      <Card className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Peptide</TableHead>
              <TableHead>Above mg</TableHead>
              <TableHead>Up to mg</TableHead>
              <TableHead>Total 1:N</TableHead>
              <TableHead>Step 1 1:N</TableHead>
              <TableHead>Cartridge</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Note</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>Order</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={12} className="py-8 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : (
              rules.map((rule, i) => (
                <RuleRow
                  key={rule.id}
                  n={i + 1}
                  rule={rule}
                  warnings={warnings[rule.id] ?? []}
                  canUp={i > 0}
                  canDown={i < rules.length - 1}
                  onMove={by => void move(i, by)}
                  {...rowProps}
                />
              ))
            )}
            {adding && (
              <RuleRow
                n={null}
                rule={null}
                warnings={[]}
                canUp={false}
                canDown={false}
                onMove={() => undefined}
                onCancel={() => setAdding(false)}
                {...rowProps}
                onSaved={s => {
                  saved(s)
                  setAdding(false)
                }}
              />
            )}
          </TableBody>
        </Table>
      </Card>
      <p className="text-sm text-muted-foreground">
        {rules.length} {rules.length === 1 ? 'rule' : 'rules'}, {trial} on trial
      </p>
    </div>
  )
}

export default EndoPrepRulesPage
