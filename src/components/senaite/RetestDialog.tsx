import { useState } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { useRetestOptions, useCreateRetest } from '@/hooks/use-retest'
import {
  HPLC_PROFILE_KEYS,
  type RetestOptions,
  type RetestRequestBody,
  type RetestCreated,
} from '@/lib/api'

export interface RetestDialogProps {
  open: boolean
  sampleId: string
  onClose: () => void
  onCreated?: (r: RetestCreated) => void
}

type RetestTab = 'retest' | 'addons'

interface RowChoice {
  retest: boolean
  carry: boolean
}

interface RetestFormState {
  tab: RetestTab
  rows: Record<string, RowChoice>
  addons: Set<string>
  varianceTicked: boolean
  variancePoints: number
  extraVials: number
  autoCheckin: boolean
  fee: 'paid' | 'free'
  reason: string
}

interface SummaryLine {
  label: string
  price: number | null
}

const formatMoney = (n: number) => `$${n.toFixed(2)}`

const isHplc = (key: string) =>
  (HPLC_PROFILE_KEYS as readonly string[]).includes(key)

const RULE_SENTENCE =
  'Rows not re-tested are carried as verified results linked to this sample. Untick Carry to leave a result off the new sample.'
const ADDON_SENTENCE =
  'Add-ons are always billed at the listed price. Existing results are carried to the new sample.'

/** Class for a 44 px tap target wrapping a small control. */
const TARGET = 'inline-flex min-h-11 min-w-11 items-center justify-center'

function initialState(options: RetestOptions): RetestFormState {
  const rows: Record<string, RowChoice> = {}
  for (const p of options.profiles)
    rows[p.key] = { retest: false, carry: p.carry_eligible }
  return {
    tab: 'retest',
    rows,
    addons: new Set(),
    varianceTicked: false,
    variancePoints: 3,
    extraVials: 0,
    autoCheckin: false,
    fee: 'paid',
    reason: '',
  }
}

function clampInt(v: string, min: number, max: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

const names = (list: { name: string }[]) => list.map(p => p.name).join(', ')

export function RetestDialog({
  open,
  sampleId,
  onClose,
  onCreated,
}: RetestDialogProps) {
  const {
    data: options,
    isLoading,
    isError,
    error,
    refetch,
  } = useRetestOptions(sampleId, open)
  const mutation = useCreateRetest(sampleId, {
    onCreated: r => {
      onCreated?.(r)
      onClose()
    },
  })
  const [state, setState] = useState<RetestFormState | null>(null)
  const [stateFor, setStateFor] = useState<string | null>(null)
  const [prevOpen, setPrevOpen] = useState(open)

  // Reset the form whenever a new options payload for a (possibly
  // different) sample loads, OR the dialog is reopened for the same
  // sample (it stays mounted, so closing must not leave a stale reason,
  // tab or ticks behind). Render-time reset per React's "adjusting state
  // when a prop changes" pattern, not an effect.
  const reopened = open && !prevOpen
  if (open !== prevOpen) setPrevOpen(open)
  if (options && (options.sample_id !== stateFor || reopened)) {
    setStateFor(options.sample_id)
    setState(initialState(options))
  }

  const pending = mutation.isPending

  function handleOpenChange(v: boolean) {
    if (!v && !pending) onClose()
  }

  if (!state || !options) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Re-test {sampleId}</DialogTitle>
          </DialogHeader>
          {isLoading && (
            <div className="flex items-center gap-2 py-6 justify-center text-sm text-muted-foreground">
              <Spinner /> Loading retest options…
            </div>
          )}
          {isError && (
            <div className="flex flex-col items-center gap-2 py-6 text-sm text-destructive">
              <span>{(error as Error)?.message ?? 'Failed to load'}</span>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                <RefreshCw size={14} /> Retry
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    )
  }

  const update = (patch: Partial<RetestFormState>) =>
    setState(s => (s ? { ...s, ...patch } : s))

  const rowOf = (key: string): RowChoice =>
    state.rows[key] ?? { retest: false, carry: false }

  // Re-test and Carry are mutually exclusive; both unticked means dropped.
  function setRow(key: string, field: keyof RowChoice, checked: boolean) {
    setState(s => {
      if (!s) return s
      const prev = s.rows[key] ?? { retest: false, carry: false }
      const next: RowChoice = checked
        ? { retest: field === 'retest', carry: field === 'carry' }
        : { ...prev, [field]: false }
      return { ...s, rows: { ...s.rows, [key]: next } }
    })
  }

  function setAddon(key: string, checked: boolean) {
    setState(s => {
      if (!s) return s
      const addons = new Set(s.addons)
      if (checked) addons.add(key)
      else addons.delete(key)
      return { ...s, addons }
    })
  }

  const tab = state.tab
  const profiles = options.profiles
  const retested = profiles.filter(p => rowOf(p.key).retest)
  const carried = profiles.filter(p => rowOf(p.key).carry)
  const dropped = profiles.filter(
    p => !rowOf(p.key).retest && !rowOf(p.key).carry
  )
  const anyRetest = retested.length > 0
  const hasHplc = profiles.some(p => isHplc(p.key))
  const hplcRetest = retested.some(p => isHplc(p.key))
  const showVariance = options.variance.allowed && hasHplc
  const varianceOn =
    showVariance &&
    hplcRetest &&
    state.varianceTicked &&
    state.variancePoints >= 2 &&
    state.variancePoints <= 10
  const tickedAddons = options.addons.filter(
    a => a.sellable && state.addons.has(a.key)
  )
  const feePrice = options.context?.retest_fee?.price ?? null
  const pointPrice = options.variance.point_price

  const summary: SummaryLine[] = []
  if (tab === 'retest') {
    if (anyRetest)
      summary.push({
        label:
          state.fee === 'free'
            ? `Retest fee (${names(retested)}), waived`
            : `Retest fee (${names(retested)})`,
        price: state.fee === 'free' ? 0 : feePrice,
      })
    if (varianceOn)
      summary.push({
        label: `Variance, ${state.variancePoints} points`,
        // Same billing as WordPress: points minus one replicates.
        price:
          pointPrice === null ? null : (state.variancePoints - 1) * pointPrice,
      })
  } else {
    for (const a of tickedAddons)
      summary.push({ label: a.name, price: a.price })
  }
  const total = summary.some(l => l.price === null)
    ? null
    : summary.reduce((sum, l) => sum + (l.price ?? 0), 0)

  const reasonText = state.reason.trim()
  let blocked: string | null = null
  if (tab === 'retest' && !anyRetest) blocked = 'Tick at least one Re-test'
  else if (tab === 'addons' && tickedAddons.length === 0)
    blocked = 'Tick at least one service'
  else if (!reasonText) blocked = 'Enter a reason'
  else if (total === null) blocked = 'Pricing unavailable'

  const eligible = profiles.filter(p => p.carry_eligible)
  const ineligible = profiles.filter(p => !p.carry_eligible)
  const sentenceParts =
    tab === 'retest'
      ? [
          retested.length ? `re-test ${names(retested)}` : '',
          carried.length ? `carry ${names(carried)}` : '',
          dropped.length ? `drop ${names(dropped)}` : '',
        ]
      : [
          eligible.length ? `carry ${names(eligible)}` : '',
          ineligible.length ? `drop ${names(ineligible)}` : '',
          tickedAddons.length ? `add ${names(tickedAddons)}` : '',
        ]
  const newSample = sentenceParts.filter(Boolean).join('; ')

  const buildBody = (): RetestRequestBody => {
    const base = {
      auto_checkin: state.autoCheckin,
      reason: reasonText,
    }
    if (tab === 'retest')
      return {
        ...base,
        retest: retested.map(p => p.key),
        carry: carried.map(p => p.key),
        drop: dropped.map(p => p.key),
        add: {
          profiles: [],
          variance_points: varianceOn ? state.variancePoints : 0,
          additional_vials: 0,
        },
        fee: state.fee,
      }
    return {
      ...base,
      retest: [],
      carry: eligible.map(p => p.key),
      drop: ineligible.map(p => p.key),
      add: {
        profiles: tickedAddons.map(a => a.key),
        variance_points: 0,
        additional_vials: state.extraVials,
      },
      fee: 'paid',
    }
  }

  const checkin = (id: string) => (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">On arrival</span>
      <span className={TARGET}>
        <Checkbox
          id={id}
          checked={state.autoCheckin}
          onCheckedChange={c => update({ autoCheckin: c === true })}
        />
      </span>
      <Label htmlFor={id}>
        Check in on creation (extra vial already on hand)
      </Label>
    </div>
  )

  const ctx = options.context
  const order = ctx?.order ?? null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {tab === 'retest'
              ? `Re-test ${sampleId}`
              : `Add services to ${sampleId}`}
          </DialogTitle>
        </DialogHeader>

        {ctx ? (
          <div
            data-testid="retest-context-block"
            className="rounded-md border border-border/40 p-3 space-y-1.5 text-sm"
          >
            {order ? (
              <>
                <div>
                  <span className="font-medium">Order {order.number}</span>
                  <span className="text-muted-foreground">
                    {' · '}
                    {order.customer_name} · {order.customer_email}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  {formatMoney(order.total)} · {order.status} ·{' '}
                  {new Date(order.placed_at).toLocaleDateString()}
                </div>
                <ul className="space-y-0.5">
                  {order.lines.map(l => (
                    <li key={l.key} className="flex justify-between gap-2">
                      <span>{l.label}</span>
                      <span>{formatMoney(l.price)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-muted-foreground">Customer info unavailable</p>
            )}
            {ctx.pending_orders.length > 0 ? (
              <div className="pt-1.5 space-y-1">
                <div className="text-xs font-medium text-muted-foreground">
                  Pending retest orders
                </div>
                {ctx.pending_orders.map(o => (
                  <div
                    key={o.order_id}
                    data-testid={`pending-retest-order-${o.order_id}`}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span>
                      Order {o.order_number} · {formatMoney(o.total)} · awaiting
                      payment
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-11"
                        onClick={() => {
                          if (!navigator.clipboard) return
                          navigator.clipboard
                            .writeText(o.payment_url)
                            .then(() => toast.success('Payment link copied'))
                            .catch(() => undefined)
                        }}
                      >
                        Copy link
                      </Button>
                      <a
                        href={o.payment_url}
                        target="_blank"
                        rel="noreferrer"
                        className={`${TARGET} px-2 underline text-muted-foreground`}
                      >
                        Open
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Customer and pricing unavailable
          </p>
        )}

        <Tabs value={tab} onValueChange={v => update({ tab: v as RetestTab })}>
          <TabsList className="w-full group-data-[orientation=horizontal]/tabs:h-auto">
            <TabsTrigger value="retest" className="min-h-11">
              Re-test
            </TabsTrigger>
            <TabsTrigger value="addons" className="min-h-11">
              Add services
            </TabsTrigger>
          </TabsList>

          <TabsContent value="retest" className="space-y-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Profile</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-center">Re-test</TableHead>
                  <TableHead className="text-center">Carry results</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profiles.map(p => {
                  const row = rowOf(p.key)
                  return (
                    <TableRow
                      key={p.key}
                      data-testid={`retest-row-${p.key}`}
                      aria-label={p.name}
                    >
                      <TableCell className="whitespace-normal">
                        {p.name}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {p.state_label}
                      </TableCell>
                      <TableCell className="text-center">
                        <span className={TARGET}>
                          <Checkbox
                            aria-label={`Re-test ${p.name}`}
                            checked={row.retest}
                            onCheckedChange={c =>
                              setRow(p.key, 'retest', c === true)
                            }
                          />
                        </span>
                      </TableCell>
                      <TableCell className="text-center whitespace-normal">
                        <span className={TARGET}>
                          <Checkbox
                            aria-label={`Carry results ${p.name}`}
                            checked={row.carry}
                            disabled={!p.carry_eligible}
                            onCheckedChange={c =>
                              setRow(p.key, 'carry', c === true)
                            }
                          />
                        </span>
                        {!p.carry_eligible && (
                          <span className="block text-xs text-muted-foreground">
                            cannot carry: not verified
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <p className="text-xs text-muted-foreground">{RULE_SENTENCE}</p>

            {showVariance && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className={TARGET}>
                  <Checkbox
                    id="variance-check"
                    aria-label="Variance"
                    checked={state.varianceTicked}
                    disabled={!hplcRetest}
                    onCheckedChange={c =>
                      update({ varianceTicked: c === true })
                    }
                  />
                </span>
                <Label htmlFor="variance-check">Variance</Label>
                <span className="text-muted-foreground">points</span>
                <Input
                  type="number"
                  min={2}
                  max={10}
                  value={state.variancePoints}
                  disabled={!hplcRetest || !state.varianceTicked}
                  aria-label="Variance points"
                  onChange={e =>
                    update({ variancePoints: clampInt(e.target.value, 0, 99) })
                  }
                  className="w-20 min-h-11"
                />
                {pointPrice !== null && (
                  <span className="text-xs text-muted-foreground">
                    @ {formatMoney(pointPrice)}/point
                  </span>
                )}
                {!hplcRetest && (
                  <span className="text-xs text-muted-foreground">
                    Requires an HPLC re-test
                  </span>
                )}
              </div>
            )}

            {anyRetest && (
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <span className="font-medium">Retest fee</span>
                <RadioGroup
                  aria-label="Retest fee"
                  value={state.fee}
                  onValueChange={v => update({ fee: v as 'paid' | 'free' })}
                  className="flex gap-4"
                >
                  <div className="flex items-center gap-2 min-h-11">
                    <RadioGroupItem id="fee-paid" value="paid" />
                    <Label htmlFor="fee-paid">
                      {feePrice === null
                        ? 'Charged (price unavailable)'
                        : `Charged ${formatMoney(feePrice)}`}
                    </Label>
                  </div>
                  <div className="flex items-center gap-2 min-h-11">
                    <RadioGroupItem id="fee-free" value="free" />
                    <Label htmlFor="fee-free">Waived</Label>
                  </div>
                </RadioGroup>
              </div>
            )}

            {checkin('auto-checkin-retest')}
          </TabsContent>

          <TabsContent value="addons" className="space-y-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-11" />
                  <TableHead>Service</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Vials</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {options.addons.map(a => (
                  <TableRow
                    key={a.key}
                    data-testid={`addon-row-${a.key}`}
                    aria-label={a.name}
                    aria-disabled={!a.sellable || undefined}
                    className={a.sellable ? undefined : 'opacity-60'}
                  >
                    <TableCell>
                      <span className={TARGET}>
                        <Checkbox
                          aria-label={a.name}
                          checked={state.addons.has(a.key)}
                          disabled={!a.sellable}
                          onCheckedChange={c => setAddon(a.key, c === true)}
                        />
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {a.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {!a.sellable
                        ? 'not sold post-order'
                        : a.price === null
                          ? 'price unavailable'
                          : formatMoney(a.price)}
                    </TableCell>
                    <TableCell>{a.vials ?? 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-xs text-muted-foreground">{ADDON_SENTENCE}</p>

            <Collapsible
              defaultOpen={state.autoCheckin || state.extraVials > 0}
            >
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-11 group/more"
                >
                  More options
                  <ChevronRight className="transition-transform group-data-[state=open]/more:rotate-90" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 pt-2 pl-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Label htmlFor="extra-vials">Extra vials to ship</Label>
                  <Input
                    id="extra-vials"
                    type="number"
                    min={0}
                    max={20}
                    value={state.extraVials}
                    onChange={e =>
                      update({ extraVials: clampInt(e.target.value, 0, 20) })
                    }
                    className="w-20 min-h-11"
                  />
                  <span className="text-xs text-muted-foreground">
                    added to the order at the per-vial price, no test
                  </span>
                </div>
                {checkin('auto-checkin-addons')}
              </CollapsibleContent>
            </Collapsible>
          </TabsContent>
        </Tabs>

        <div>
          <Label htmlFor="retest-reason">Reason (required)</Label>
          <Textarea
            id="retest-reason"
            value={state.reason}
            onChange={e => update({ reason: e.target.value })}
          />
        </div>

        <div
          data-testid="retest-summary"
          aria-label="Summary"
          className="rounded-md border border-border/40 p-3 text-sm space-y-0.5"
        >
          <div className="font-medium">Summary</div>
          {summary.map(l => (
            <div key={l.label} className="flex justify-between gap-2">
              <span>{l.label}</span>
              <span>
                {l.price === null ? 'price unavailable' : formatMoney(l.price)}
              </span>
            </div>
          ))}
          <div
            data-testid="retest-summary-total"
            className="flex justify-between gap-2 font-medium border-t border-border/40 pt-1"
          >
            {total === null ? (
              <span>Total: price unavailable</span>
            ) : (
              <>
                <span>Total</span>
                <span>{formatMoney(total)}</span>
              </>
            )}
          </div>
        </div>

        {newSample && (
          <p data-testid="retest-new-sample" className="text-sm">
            New sample: {newSample}.
          </p>
        )}

        <DialogFooter className="sm:items-center">
          {blocked && (
            <span
              data-testid="retest-disabled-reason"
              className="text-sm text-muted-foreground sm:mr-auto"
            >
              {blocked}
            </span>
          )}
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            className="min-h-11"
            onClick={() => mutation.mutate(buildBody())}
            disabled={blocked !== null || pending}
          >
            {pending
              ? 'Creating…'
              : tab === 'retest'
                ? 'Create retest order'
                : 'Create add-on order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
