import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react'
import { Loader2, Info, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { toast } from 'sonner'
import {
  listServiceSpecs,
  createServiceSpec,
  patchServiceSpec,
  type AnalysisServiceSpecRecord,
  type ServiceSpecPayload,
  type PeptideRecord,
} from '@/lib/api'

/** Mirrors backend/main.py `_SPEC_MATRICES` — extend both in lockstep. */
const SPEC_MATRICES = ['Peptide', 'Bacteriostatic Water'] as const

type Tier = 'all' | 'matrix' | 'peptide'

/** Readable rule text: "≤ 0.5 µg/g", "1 – 5 µg/g", "≥ 0.5 µg/g", "= Not Detected".
 *  A range rule with an LOQ filed appends " · LOQ {loq}" — equals-kind specs
 *  are never censored (backend never reads loq off them), so the equals
 *  branch stays untouched. */
function ruleLabel(spec: AnalysisServiceSpecRecord): string {
  // Report-only rows carry no bounds by construction — the admin list says
  // "As measured"; the COA's spec cell renders display_override or empty (R1).
  if (spec.rule_kind === 'informational')
    return spec.display_override ? `As measured · ${spec.display_override}` : 'As measured'
  if (spec.rule_kind === 'equals') return `= ${spec.equals_value ?? '—'}`
  const unit = spec.unit ? ` ${spec.unit}` : ''
  const { min_value, max_value, loq } = spec
  const loqSuffix = loq != null ? ` · LOQ ${loq}` : ''
  if (min_value != null && max_value != null)
    return `${min_value} – ${max_value}${unit}${loqSuffix}`
  if (min_value != null) return `≥ ${min_value}${unit}${loqSuffix}`
  if (max_value != null) return `≤ ${max_value}${unit}${loqSuffix}`
  return '—'
}

const tierChip = (spec: AnalysisServiceSpecRecord): string =>
  spec.peptide_code ?? spec.matrix ?? 'All'

interface AddFormState {
  tier: Tier
  matrix: string
  peptideId: number | null
  peptideQuery: string
  ruleKind: 'range' | 'equals' | 'informational'
  minValue: string
  maxValue: string
  equalsValue: string
  unit: string
  displayOverride: string
  loq: string
}

const EMPTY_FORM: AddFormState = {
  tier: 'all',
  matrix: '',
  peptideId: null,
  peptideQuery: '',
  ruleKind: 'range',
  minValue: '',
  maxValue: '',
  equalsValue: '',
  unit: '',
  displayOverride: '',
  loq: '',
}

/** Mirrors backend `_validate_spec_shape` (main.py:3443) — structural only,
 *  no client-side numeric checks the server doesn't also enforce. */
function isFormValid(f: AddFormState): boolean {
  if (f.tier === 'matrix' && !f.matrix) return false
  if (f.tier === 'peptide' && f.peptideId == null) return false
  if (f.ruleKind === 'informational') return true // no bounds by design
  if (f.ruleKind === 'range')
    return f.minValue.trim() !== '' || f.maxValue.trim() !== ''
  return f.equalsValue.trim() !== ''
}

function buildPayload(f: AddFormState): ServiceSpecPayload {
  return {
    matrix: f.tier === 'matrix' ? f.matrix : null,
    peptide_id: f.tier === 'peptide' ? f.peptideId : null,
    rule_kind: f.ruleKind,
    min_value: f.ruleKind === 'range' ? f.minValue.trim() || null : null,
    max_value: f.ruleKind === 'range' ? f.maxValue.trim() || null : null,
    equals_value: f.ruleKind === 'equals' ? f.equalsValue.trim() : null,
    // informational sends no bounds/equals/loq — the backend 422s them
    // loudly (R3), so the payload never even offers the temptation.
    unit: f.unit.trim() || null,
    display_override: f.displayOverride.trim() || null,
    loq: f.ruleKind === 'range' ? f.loq.trim() || null : null,
  }
}

function Field({
  label,
  tooltip,
  className,
  children,
}: {
  label: string
  tooltip?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <div className="flex items-center gap-1">
        <label className="text-xs font-medium">{label}</label>
        {tooltip && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3 w-3 text-muted-foreground cursor-default" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs text-xs">
                {tooltip}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {children}
    </div>
  )
}

function InputField({
  label,
  value,
  onChange,
  className = 'w-24',
  placeholder,
  tooltip,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  className?: string
  placeholder?: string
  tooltip?: ReactNode
}) {
  return (
    <Field label={label} tooltip={tooltip} className={className}>
      <Input
        aria-label={label}
        className="h-8 text-sm"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </Field>
  )
}

/**
 * Lab-owned pass/fail spec rules for one analysis service. Peptide-tier and
 * matrix-tier specs are mutually exclusive per row (backend-enforced); "All"
 * means neither is set. Rows are deactivated, never deleted — no delete
 * affordance here on purpose.
 */
export function ServiceSpecsSection({
  serviceId,
  peptides,
}: {
  serviceId: number
  peptides: PeptideRecord[]
}) {
  const [specs, setSpecs] = useState<AnalysisServiceSpecRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<AddFormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSpecs(await listServiceSpecs(serviceId))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load specs')
    } finally {
      setLoading(false)
    }
  }, [serviceId])

  useEffect(() => {
    load()
  }, [load])

  const filteredPeptides = useMemo(() => {
    const q = form.peptideQuery.trim().toLowerCase()
    return peptides
      .filter(p => p.active)
      .filter(
        p =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.abbreviation.toLowerCase().includes(q)
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [peptides, form.peptideQuery])

  const selectedPeptide = peptides.find(p => p.id === form.peptideId) ?? null

  const handleDeactivate = async (spec: AnalysisServiceSpecRecord) => {
    if (
      !window.confirm(
        `Deactivate the "${tierChip(spec)}" spec (${ruleLabel(spec)})?`
      )
    )
      return
    try {
      await patchServiceSpec(spec.id, { active: false })
      await load()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to deactivate spec'
      )
    }
  }

  const handleAdd = async () => {
    if (!isFormValid(form)) return
    setSubmitting(true)
    setAddError(null)
    try {
      await createServiceSpec(serviceId, buildPayload(form))
      setForm(EMPTY_FORM)
      await load()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to create spec')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="border-t pt-4">
      <div className="mb-3 flex items-center gap-1.5">
        <h4 className="text-sm font-semibold text-muted-foreground">
          Specs ({specs.length})
        </h4>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-default" />
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-xs">
              <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                  Tier precedence
                </div>
                <div>Peptide-specific overrides Matrix overrides All.</div>
                <div>COA generation fails closed if no tier matches.</div>
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : specs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No specs yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 text-xs">Tier</TableHead>
              <TableHead className="h-8 text-xs">Rule</TableHead>
              <TableHead className="h-8 text-xs">Display</TableHead>
              <TableHead className="h-8 w-20 text-xs"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {specs.map(spec => (
              <TableRow key={spec.id}>
                <TableCell className="py-1.5 text-sm">
                  <Badge variant="outline" className="text-xs">
                    {tierChip(spec)}
                  </Badge>
                </TableCell>
                <TableCell className="py-1.5 text-sm font-mono">
                  {ruleLabel(spec)}
                </TableCell>
                <TableCell className="py-1.5 text-sm text-muted-foreground">
                  {spec.display_override ?? '—'}
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleDeactivate(spec)}
                  >
                    Deactivate
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Add spec */}
      <div className="mt-4 space-y-3 rounded-md border p-3">
        <div className="flex flex-wrap gap-3">
          <Field label="Tier" className="w-32">
            <Select
              value={form.tier}
              onValueChange={v =>
                setForm(f => ({
                  ...f,
                  tier: v as Tier,
                  matrix: '',
                  peptideId: null,
                  peptideQuery: '',
                }))
              }
            >
              <SelectTrigger aria-label="Tier" className="h-8 w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="matrix">Matrix</SelectItem>
                <SelectItem value="peptide">Peptide</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {form.tier === 'matrix' && (
            <Field label="Matrix" className="w-44">
              <Select
                value={form.matrix}
                onValueChange={v => setForm(f => ({ ...f, matrix: v }))}
              >
                <SelectTrigger
                  aria-label="Matrix"
                  className="h-8 w-full text-sm"
                >
                  <SelectValue placeholder="Select matrix…" />
                </SelectTrigger>
                <SelectContent>
                  {SPEC_MATRICES.map(m => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Rule" className="w-28">
            <Select
              value={form.ruleKind}
              onValueChange={v =>
                setForm(f => ({
                  ...f,
                  ruleKind: v as 'range' | 'equals' | 'informational',
                }))
              }
            >
              <SelectTrigger aria-label="Rule" className="h-8 w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="range">Range</SelectItem>
                <SelectItem value="equals">Equals</SelectItem>
                <SelectItem value="informational">Report as measured</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {form.ruleKind === 'informational' ? (
            <Field label="" className="flex-1 min-w-40">
              <p className="text-xs text-muted-foreground pt-1.5">
                No verdict — the measured value prints as-is with a neutral
                status. Use Display override below for optional spec-cell text.
              </p>
            </Field>
          ) : form.ruleKind === 'range' ? (
            <>
              <InputField
                label="Min"
                value={form.minValue}
                onChange={v => setForm(f => ({ ...f, minValue: v }))}
              />
              <InputField
                label="Max"
                value={form.maxValue}
                onChange={v => setForm(f => ({ ...f, maxValue: v }))}
              />
              <InputField
                label="LOQ"
                value={form.loq}
                onChange={v => setForm(f => ({ ...f, loq: v }))}
                placeholder="e.g. 0.5"
                tooltip={
                  'Limit of quantitation in the spec\'s unit. Results below it print as "< LOQ" on the COA; the pass/fail verdict still uses the raw number.'
                }
              />
            </>
          ) : (
            <InputField
              label="Equals"
              value={form.equalsValue}
              onChange={v => setForm(f => ({ ...f, equalsValue: v }))}
              className="w-32"
            />
          )}
          <InputField
            label="Unit"
            value={form.unit}
            onChange={v => setForm(f => ({ ...f, unit: v }))}
            className="w-20"
          />
          <InputField
            label="Display override"
            value={form.displayOverride}
            onChange={v => setForm(f => ({ ...f, displayOverride: v }))}
            className="min-w-32 flex-1"
          />
        </div>

        {form.tier === 'peptide' && (
          <Field label="Peptide">
            {selectedPeptide ? (
              <div className="flex items-center gap-2">
                <Badge variant="secondary">
                  {selectedPeptide.abbreviation || selectedPeptide.name}
                </Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setForm(f => ({ ...f, peptideId: null }))}
                >
                  Change
                </Button>
              </div>
            ) : (
              <>
                <div className="relative max-w-xs">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="h-8 pl-8 text-sm"
                    placeholder="Search peptides…"
                    value={form.peptideQuery}
                    onChange={e =>
                      setForm(f => ({ ...f, peptideQuery: e.target.value }))
                    }
                  />
                </div>
                <div className="max-h-32 max-w-xs overflow-y-auto rounded-md border">
                  {filteredPeptides.length === 0 ? (
                    <p className="p-2 text-xs text-muted-foreground">
                      No matching peptides.
                    </p>
                  ) : (
                    filteredPeptides.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() =>
                          setForm(f => ({ ...f, peptideId: p.id }))
                        }
                        className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-sm hover:bg-muted/60"
                      >
                        <span className="truncate">{p.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {p.abbreviation}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </Field>
        )}

        {addError && <p className="text-xs text-destructive">{addError}</p>}

        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!isFormValid(form) || submitting}
            onClick={handleAdd}
          >
            {submitting && (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            )}
            Add Spec
          </Button>
        </div>
      </div>
    </div>
  )
}
