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
import {
  useRetestOptions,
  useCreateRetest,
  useCreateAddonOrder,
} from '@/hooks/use-retest'
import {
  HPLC_PROFILE_KEYS,
  type RetestOptions,
  type RetestRequestBody,
  type RetestCreated,
  type RetestOrder,
} from '@/lib/api'

export interface RetestDialogProps {
  open: boolean
  sampleId: string
  onClose: () => void
  onCreated?: (r: RetestCreated) => void
}

type RetestTab = 'retest' | 'addons' | 'orders'

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
  key: string
  label: string
  /** 'shop' = priced by WordPress at checkout, left out of the Total. */
  price: number | null | 'shop'
}

const formatMoney = (n: number) => `$${n.toFixed(2)}`

const isHplc = (key: string) =>
  (HPLC_PROFILE_KEYS as readonly string[]).includes(key)

const RULE_SENTENCE =
  'Rows not re-tested are carried as verified results linked to this sample. Untick Carry to leave a result off the new sample.'
const ADDON_BILLING =
  'Add-ons are billed at the listed price unless Billing is Waived.'
const ADDON_SENTENCE = `${ADDON_BILLING} Existing results are carried to the new sample.`
const LEGACY_RULE =
  ' Results from the previous system cannot be carried; re-test them if they are needed on the new certificate.'
const NO_PROFILES =
  'No tests on record for this sample; nothing can be re-tested or carried.'
/** Amber note, shared by the unpaid strip and the context error. */
const AMBER =
  'rounded-md border border-amber-500/40 bg-amber-500/10 px-3 text-sm text-amber-900 dark:text-amber-200'

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

function copyLink(url: string) {
  if (!navigator.clipboard) {
    toast.error('Copy failed')
    return
  }
  navigator.clipboard
    .writeText(url)
    .then(() => toast.success('Payment link copied'))
    .catch(() => toast.error('Copy failed'))
}

/** About 760 px: the four-column profile table fits without wrapping. */
const WIDTH = 'sm:max-w-[760px]'

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
  const addonMutation = useCreateAddonOrder(sampleId, {
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

  const pending = mutation.isPending || addonMutation.isPending

  function handleOpenChange(v: boolean) {
    if (!v && !pending) onClose()
  }

  if (!state || !options) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className={WIDTH}>
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

  const rowOf = (p: { key: string; carry_eligible: boolean }): RowChoice =>
    state.rows[p.key] ?? { retest: false, carry: p.carry_eligible }

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
  // In progress (not yet published): Add services adds to this same sample.
  // Older backends omit the flag, which means today's new-sample path.
  const sameSample = tab === 'addons' && options.original_published === false
  const profiles = options.profiles
  const retested = profiles.filter(p => rowOf(p).retest)
  const carried = profiles.filter(p => rowOf(p).carry)
  const dropped = profiles.filter(p => !rowOf(p).retest && !rowOf(p).carry)
  const anyRetest = retested.length > 0
  const hasHplc = profiles.some(p => isHplc(p.key))
  const hplcRetest = retested.some(p => isHplc(p.key))
  const showVariance = options.variance.allowed && hasHplc
  const varianceWanted = showVariance && hplcRetest && state.varianceTicked
  const varianceOutOfRange =
    varianceWanted && (state.variancePoints < 2 || state.variancePoints > 10)
  const varianceOn = varianceWanted && !varianceOutOfRange
  const tickedAddons = options.addons.filter(
    a => a.sellable && state.addons.has(a.key)
  )
  const feePrice = options.context?.retest_fee?.price ?? null
  const pointPrice = options.variance.point_price
  // Waived = the whole order is free; list prices stay visible, struck to $0.
  const waived = state.fee === 'free'

  const summary: SummaryLine[] = []
  if (tab === 'retest') {
    if (anyRetest)
      summary.push({
        key: 'fee',
        label: `Retest fee (${names(retested)})`,
        price: feePrice,
      })
    if (varianceOn)
      summary.push({
        key: 'variance',
        label: `Variance, ${state.variancePoints} points`,
        // Same billing as WordPress: points minus one replicates.
        price:
          pointPrice === null ? null : (state.variancePoints - 1) * pointPrice,
      })
  }
  // Add-ons ride on both tabs (the Re-test tab's "Also add services").
  for (const a of tickedAddons)
    summary.push({ key: `addon-${a.key}`, label: a.name, price: a.price })
  if (state.extraVials > 0)
    summary.push({
      key: 'extra-vials',
      label: `Extra vials, ${state.extraVials}: price set by the shop`,
      price: 'shop',
    })
  const total = summary.some(l => l.price === null)
    ? null
    : summary.reduce(
        (sum, l) => sum + (typeof l.price === 'number' ? l.price : 0),
        0
      )
  const excludesExtraVials = summary.some(l => l.price === 'shop')

  const contextError = options.context_error ?? null
  // No order to bill against: nothing can be created, Waived included.
  const hardStop =
    contextError?.kind === 'no_order' || contextError?.kind === 'order_missing'
      ? contextError.message
      : null
  const noProfiles = options.profiles_source === 'none'

  const reasonText = state.reason.trim()
  let blocked: string | null = null
  if (tab === 'orders') blocked = null
  else if (hardStop) blocked = hardStop
  else if (tab === 'retest' && !anyRetest) blocked = 'Tick at least one Re-test'
  else if (tab === 'addons' && tickedAddons.length === 0)
    blocked = 'Tick at least one service'
  else if (tab === 'retest' && varianceOutOfRange)
    blocked = 'Variance points must be 2 to 10'
  else if (!reasonText) blocked = 'Enter a reason'
  else if (total === null && !waived) blocked = 'Pricing unavailable'

  const eligible = profiles.filter(p => p.carry_eligible)
  const ineligible = profiles.filter(p => !p.carry_eligible)
  // "When you press Create": built from the same state as the request body,
  // so it cannot say something the request does not do.
  const outcome: string[] = []
  if (tab === 'retest' ? anyRetest : tickedAddons.length > 0) {
    const kind = tab === 'retest' ? 'retest order' : 'add-on order'
    const orig = options.context?.order
    const who = orig
      ? `for ${orig.customer_name} against order ${orig.number}`
      : 'for the customer against the original order'
    const money = waived
      ? total
        ? `$0.00, waived ${formatMoney(total)}`
        : '$0.00, waived'
      : total === null
        ? 'price unavailable'
        : excludesExtraVials
          ? `${formatMoney(total)} plus extra vials`
          : formatMoney(total)
    outcome.push(`Creates a WooCommerce ${kind} ${who} (${money}).`)
    const gate = waived ? 'At once' : 'Once paid'
    if (tab === 'retest') {
      outcome.push(
        `${gate}: a new sample is created with ${names(retested)} re-tested` +
          (varianceOn ? ` (variance, ${state.variancePoints} points)` : '') +
          (carried.length
            ? `; ${names(carried)} carried as verified results`
            : '') +
          (dropped.length ? `; ${names(dropped)} dropped` : '') +
          (tickedAddons.length ? `; ${names(tickedAddons)} added` : '') +
          '.'
      )
    } else if (sameSample) {
      const vials =
        tickedAddons.reduce((n, a) => n + (a.vials ?? 0), 0) + state.extraVials
      outcome.push(
        `${gate}: ${names(tickedAddons)} added to ${sampleId}` +
          (vials > 0
            ? `; needs ${vials} more vial${vials === 1 ? '' : 's'} from the customer`
            : '') +
          '.'
      )
    } else {
      outcome.push(
        `${gate}: a new sample is created with ${names(tickedAddons)}` +
          (eligible.length
            ? `; ${names(eligible)} carried from ${sampleId}`
            : '') +
          (ineligible.length
            ? `; ${names(ineligible)} dropped (not verified)`
            : '') +
          '.'
      )
    }
    outcome.push(
      sameSample
        ? `No new sample; ${sampleId} keeps its current results.`
        : `${sampleId} is unchanged and stays linked to the new sample.` +
            (state.autoCheckin
              ? ' The new sample is checked in on creation.'
              : '')
    )
    // Email facts from the WordPress side: payment_complete() on a waived
    // order sends WooCommerce's order confirmation; a charged retest / new-
    // sample order is emailed an invoice with the pay link; the same-sample
    // addon-order route leaves a charged order pending with no email.
    outcome.push(
      waived
        ? "Email: the customer gets WooCommerce's order confirmation now (no payment needed)."
        : sameSample
          ? 'Email: none now; copy the payment link from the Orders tab. The order confirmation goes out when the customer pays.'
          : 'Email: the customer is sent an invoice with the payment link now; the order confirmation follows when they pay.'
    )
  }

  const submit = () => {
    if (sameSample)
      addonMutation.mutate({
        profiles: tickedAddons.map(a => a.key),
        variance_points: 0,
        additional_vials: state.extraVials,
        fee: state.fee,
        reason: reasonText,
      })
    else mutation.mutate(buildBody())
  }

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
          profiles: tickedAddons.map(a => a.key),
          variance_points: varianceOn ? state.variancePoints : 0,
          additional_vials: state.extraVials,
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
      fee: state.fee,
    }
  }

  const billing = (
    <div className="flex flex-wrap items-center gap-4 text-sm">
      <span className="font-medium">Billing</span>
      <RadioGroup
        aria-label="Billing"
        value={state.fee}
        onValueChange={v => update({ fee: v as 'paid' | 'free' })}
        className="flex gap-4"
      >
        <div className="flex items-center gap-2 min-h-11">
          <RadioGroupItem id={`fee-paid-${tab}`} value="paid" />
          <Label htmlFor={`fee-paid-${tab}`}>Charged</Label>
        </div>
        <div className="flex items-center gap-2 min-h-11">
          <RadioGroupItem id={`fee-free-${tab}`} value="free" />
          <Label htmlFor={`fee-free-${tab}`}>Waived (whole order free)</Label>
        </div>
      </RadioGroup>
    </div>
  )

  const linePrice = (price: SummaryLine['price']) => {
    if (waived)
      return typeof price === 'number'
        ? `$0.00 (waived ${formatMoney(price)})`
        : '$0.00 (waived)'
    if (price === 'shop') return null
    return price === null ? 'price unavailable' : formatMoney(price)
  }

  const checkin = (prefix: boolean) => (
    <div className="flex items-center gap-2 text-sm">
      {prefix && <span className="text-muted-foreground">On arrival</span>}
      <label className="inline-flex min-h-11 items-center gap-2 cursor-pointer">
        <span className={TARGET}>
          <Checkbox
            checked={state.autoCheckin}
            onCheckedChange={c => update({ autoCheckin: c === true })}
          />
        </span>
        Check in on creation (extra vial already on hand)
      </label>
    </div>
  )

  // One add-on table, one `addons` set: rendered on Add services and as
  // "Also add services" on Re-test (only one tab is mounted at a time).
  const addonTable = (
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
              <label className={TARGET}>
                <Checkbox
                  aria-label={a.name}
                  checked={state.addons.has(a.key)}
                  disabled={!a.sellable}
                  onCheckedChange={c => setAddon(a.key, c === true)}
                />
              </label>
            </TableCell>
            <TableCell className="whitespace-normal">{a.name}</TableCell>
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
  )

  const moreOptions = (withCheckin: boolean) => (
    <Collapsible
      defaultOpen={(withCheckin && state.autoCheckin) || state.extraVials > 0}
    >
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="min-h-11 group/more">
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
        {withCheckin && checkin(false)}
      </CollapsibleContent>
    </Collapsible>
  )

  const ctx = options.context
  const order = ctx?.order ?? null
  // Older WordPress sends only pending_retest_orders: show those as unpaid rows.
  const orders: RetestOrder[] = ctx?.orders?.length
    ? ctx.orders
    : (ctx?.pending_orders ?? []).map(o => ({
        ...o,
        paid_at: null,
        kind: 'retest' as const,
        sample_id: null,
        sample_status: null,
      }))
  const unpaid = orders.filter(o => o.payment_url)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={`${WIDTH} max-h-[90vh] overflow-y-auto`}>
        <DialogHeader>
          <DialogTitle>
            {tab === 'addons'
              ? `Add services to ${sampleId}`
              : `Re-test ${sampleId}`}
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
          </div>
        ) : (
          !contextError && (
            <p className="text-sm text-muted-foreground">
              Customer and pricing unavailable
            </p>
          )
        )}

        {contextError && (
          <p
            role="status"
            data-testid="retest-context-error"
            className={`${AMBER} py-2`}
          >
            {contextError.message}
          </p>
        )}

        {unpaid.length > 0 && (
          <div
            role="status"
            data-testid="retest-unpaid-strip"
            className={`flex items-center gap-1 ${AMBER}`}
          >
            <span>
              {unpaid.length} unpaid retest order
              {unpaid.length === 1 ? '' : 's'}:{' '}
              {unpaid.map(o => o.order_number).join(', ')} ·
            </span>
            <Button
              variant="link"
              size="sm"
              className="min-h-11 px-1 text-inherit underline"
              onClick={() => update({ tab: 'orders' })}
            >
              View
            </Button>
          </div>
        )}

        <Tabs value={tab} onValueChange={v => update({ tab: v as RetestTab })}>
          <TabsList className="w-full group-data-[orientation=horizontal]/tabs:h-auto">
            <TabsTrigger value="retest" className="min-h-11">
              Re-test
            </TabsTrigger>
            <TabsTrigger value="addons" className="min-h-11">
              Add services
            </TabsTrigger>
            <TabsTrigger value="orders" className="min-h-11">
              {unpaid.length > 0 ? `Orders (${unpaid.length})` : 'Orders'}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="retest" className="space-y-3">
            {noProfiles ? (
              <p
                data-testid="retest-no-profiles"
                className="py-4 text-sm text-muted-foreground"
              >
                {NO_PROFILES}
              </p>
            ) : (
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
                    const row = rowOf(p)
                    return (
                      <TableRow
                        key={p.key}
                        data-testid={`retest-row-${p.key}`}
                        aria-label={p.name}
                      >
                        <TableCell className="whitespace-normal">
                          {p.name}
                          {p.legacy && (
                            <span
                              data-testid={`retest-legacy-tag-${p.key}`}
                              title="Result from the previous system (SENAITE)"
                              className="ml-2 rounded border border-border/60 px-1.5 py-0.5 text-xs text-muted-foreground"
                            >
                              SENAITE-era
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {p.state_label}
                        </TableCell>
                        <TableCell className="text-center">
                          <label className={TARGET}>
                            <Checkbox
                              aria-label={`Re-test ${p.name}`}
                              checked={row.retest}
                              onCheckedChange={c =>
                                setRow(p.key, 'retest', c === true)
                              }
                            />
                          </label>
                        </TableCell>
                        <TableCell className="text-center whitespace-normal">
                          <label className={TARGET}>
                            <Checkbox
                              aria-label={`Carry results ${p.name}`}
                              checked={row.carry}
                              disabled={!p.carry_eligible}
                              onCheckedChange={c =>
                                setRow(p.key, 'carry', c === true)
                              }
                            />
                          </label>
                          {!p.carry_eligible && (
                            <span className="block text-xs text-muted-foreground">
                              {p.carry_blocked_reason ??
                                'cannot carry: not verified'}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
            {!noProfiles && (
              <p className="text-xs text-muted-foreground">
                {options.profiles_source === 'rows'
                  ? RULE_SENTENCE + LEGACY_RULE
                  : RULE_SENTENCE}
              </p>
            )}

            {showVariance && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className={TARGET}>
                  <Checkbox
                    id="variance-check"
                    aria-label="Variance"
                    checked={state.varianceTicked}
                    disabled={!hplcRetest}
                    onCheckedChange={c =>
                      update({ varianceTicked: c === true })
                    }
                  />
                </label>
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
                    update({ variancePoints: clampInt(e.target.value, 2, 10) })
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

            {!noProfiles && options.addons.length > 0 && (
              <section
                data-testid="retest-also-add"
                aria-labelledby="retest-also-add-title"
                className="space-y-2 border-t border-border/40 pt-3"
              >
                <h3 id="retest-also-add-title" className="text-sm font-medium">
                  Also add services
                </h3>
                {addonTable}
                <p className="text-xs text-muted-foreground">{ADDON_BILLING}</p>
                {moreOptions(false)}
              </section>
            )}

            {billing}

            {checkin(true)}
          </TabsContent>

          <TabsContent value="addons" className="space-y-3">
            <p data-testid="addon-mode" className="text-sm">
              {options.original_published === false
                ? `${sampleId} is in progress: the selected services are added to this sample once the order is paid (or at once if waived).`
                : `${sampleId} is published: a new sample is created with the existing results carried.`}
            </p>
            {addonTable}
            <p className="text-xs text-muted-foreground">
              {sameSample ? ADDON_BILLING : ADDON_SENTENCE}
            </p>
            {/* The addon-order route has no auto check-in. */}
            {moreOptions(!sameSample)}
            {billing}
          </TabsContent>

          <TabsContent value="orders">
            {orders.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No retest orders for this sample yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Total</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Sample</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map(o => (
                    <TableRow
                      key={o.order_id}
                      data-testid={`retest-order-${o.order_id}`}
                      aria-label={`Order ${o.order_number}`}
                    >
                      <TableCell>{o.order_number}</TableCell>
                      <TableCell>
                        {o.kind === 'addon' ? 'Add-on' : 'Retest'}
                      </TableCell>
                      <TableCell>
                        {new Date(o.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell>{formatMoney(o.total)}</TableCell>
                      <TableCell>{o.status}</TableCell>
                      <TableCell>
                        {o.same_sample ? (
                          <span className="text-muted-foreground">
                            {o.applied ? 'applied' : 'same sample'}
                          </span>
                        ) : o.sample_id ? (
                          <a
                            href={`#senaite/sample-details?id=${encodeURIComponent(o.sample_id)}`}
                            className="underline"
                          >
                            {o.sample_id}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">not yet</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {o.payment_url && (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="outline"
                              size="sm"
                              className="min-h-11"
                              aria-label={`Copy payment link for order ${o.order_number}`}
                              onClick={() =>
                                o.payment_url && copyLink(o.payment_url)
                              }
                            >
                              Copy link
                            </Button>
                            <a
                              href={o.payment_url}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Open payment page for order ${o.order_number}`}
                              className={`${TARGET} px-2 underline text-muted-foreground`}
                            >
                              Open
                            </a>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>
        </Tabs>

        {tab !== 'orders' && (
          <>
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
                <div key={l.key} className="flex justify-between gap-2">
                  <span>{l.label}</span>
                  <span>{linePrice(l.price)}</span>
                </div>
              ))}
              <div
                data-testid="retest-summary-total"
                className="flex justify-between gap-2 font-medium border-t border-border/40 pt-1"
              >
                {waived ? (
                  <>
                    <span>Total</span>
                    <span>$0.00 (waived)</span>
                  </>
                ) : total === null ? (
                  <span>Total: price unavailable</span>
                ) : (
                  <>
                    <span>
                      {excludesExtraVials
                        ? 'Total (excluding extra vials)'
                        : 'Total'}
                    </span>
                    <span>{formatMoney(total)}</span>
                  </>
                )}
              </div>
              {outcome.length > 0 && (
                <div
                  data-testid="retest-outcome"
                  className="border-t border-border/40 pt-1.5 mt-1.5 space-y-0.5"
                >
                  <div className="font-medium">When you press Create</div>
                  {outcome.map(line => (
                    <p key={line} className="text-muted-foreground">
                      {line}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </>
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
          {tab !== 'orders' && (
            <Button
              className="min-h-11"
              onClick={submit}
              disabled={blocked !== null || pending}
            >
              {pending
                ? 'Creating…'
                : tab === 'retest'
                  ? 'Create retest order'
                  : sameSample
                    ? `Add services to ${sampleId}`
                    : 'Create add-on order (new sample)'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
