import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, ListOrdered, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  getInstruments,
  getPeptides,
  reorderHplcPrepRules,
  type HplcPrepRuleSaved,
} from '@/lib/api'
import type { HplcPrepRule } from '@/lib/hplc-prep-rules'
import {
  HPLC_PREP_RULES_KEY,
  useHplcPrepRules,
} from '@/services/hplc-prep-rules'
import { RuleRow } from './HplcPrepRuleBits'

/** The columns between "#" and Active, in the lab sheet's order and words. */
const COLUMNS = [
  'Peptide',
  'Weight (mg)',
  'Target Conc (ug/mL)',
  'Target in a blend (ug/mL)',
  'Lead',
  'Diluent',
  'Floor (ug/mL)',
  'Instrument',
  'Status',
  'Note',
] as const

/**
 * The HPLC prep rules (plan 2026-11-12-hplc-prep-rules): per catalog peptide
 * or blend and weight band, the target, the blend target, the lead, the
 * diluent, the floor and the usual instrument. The endotoxin rules page's
 * twin: editable in place, and the order breaks ties between lines.
 */
export function HplcPrepRulesPage() {
  const queryClient = useQueryClient()
  const { data: rules = [], isLoading, error } = useHplcPrepRules()
  const { data: peptides = [] } = useQuery({
    queryKey: ['peptides'],
    queryFn: () => getPeptides(),
    staleTime: 5 * 60 * 1000,
  })
  const { data: instruments = [] } = useQuery({
    queryKey: ['instruments'],
    queryFn: getInstruments,
    staleTime: 5 * 60 * 1000,
  })
  const [adding, setAdding] = useState(false)
  const [warnings, setWarnings] = useState<Record<number, string[]>>({})
  const [moving, setMoving] = useState(false)
  const trial = rules.filter(r => r.status === 'trial').length

  function saved({ rule, warnings: w }: HplcPrepRuleSaved) {
    queryClient.setQueryData<HplcPrepRule[]>(HPLC_PREP_RULES_KEY, list =>
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
        HPLC_PREP_RULES_KEY,
        await reorderHplcPrepRules(ids)
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reorder failed')
    } finally {
      setMoving(false)
    }
  }

  const rowProps = { peptides, instruments, moving, onSaved: saved }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ListOrdered className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">HPLC prep rules</h1>
            <p className="text-sm text-muted-foreground">
              The HPLC prep per catalog peptide or blend and weight band. A
              blank value keeps the method standard, never zero.
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

      <p className="text-sm text-muted-foreground">
        A blend is made to its lead&apos;s target. A rule on the blend itself
        names the lead; without one, the component with the lowest rank leads,
        then the heaviest. A component that comes out below the floor only
        warns: the prep still runs.
      </p>

      <Card className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              {COLUMNS.map(c => (
                <TableHead key={c}>{c}</TableHead>
              ))}
              <TableHead>Active</TableHead>
              <TableHead>Order</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={14} className="py-8 text-center">
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

export default HplcPrepRulesPage
