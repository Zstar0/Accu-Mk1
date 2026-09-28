import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { useRetestOptions, useCreateRetest } from '@/hooks/use-retest'
import {
  HPLC_PROFILE_KEYS,
  type RetestOptionAddon,
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

interface RetestFormState {
  /** key -> true when set to Retest, false when Carry. */
  toggles: Record<string, boolean>
  addons: Record<string, boolean>
  varianceTicked: boolean
  variancePoints: number
  shipVials: number
  fee: 'paid' | 'free'
  autoCheckin: boolean
  reason: string
}

const formatMoney = (n: number) => `$${n.toFixed(2)}`

export function retestDelta(sel: {
  addons: RetestOptionAddon[]
  variancePoints: number
  pointPrice: number | null
  /** Omit to leave the retest fee out of the delta entirely (e.g. order
   * context unavailable); pass null when the fee applies but its price is
   * unknown, which makes the whole delta unavailable like a missing
   * add-on price. */
  retestFeePrice?: number | null
}): number | null {
  let total = 0
  for (const a of sel.addons) {
    if (a.price === null) return null
    total += a.price
  }
  if (sel.variancePoints > 0) {
    if (sel.pointPrice === null) return null
    total += (sel.variancePoints - 1) * sel.pointPrice
  }
  if (sel.retestFeePrice !== undefined) {
    if (sel.retestFeePrice === null) return null
    total += sel.retestFeePrice
  }
  return total
}

export function buildRetestBody(
  state: RetestFormState,
  options: RetestOptions
): RetestRequestBody {
  const retest = options.profiles
    .filter(p => state.toggles[p.key])
    .map(p => p.key)
  const carry = options.profiles
    .filter(p => !state.toggles[p.key])
    .map(p => p.key)
  const tickedAddonKeys = options.addons
    .filter(a => a.wp_type && state.addons[a.key])
    .map(a => a.key)
  const hplcSetToRetest = retest.some(k =>
    (HPLC_PROFILE_KEYS as readonly string[]).includes(k)
  )
  const varianceEffective =
    hplcSetToRetest &&
    state.varianceTicked &&
    state.variancePoints >= 2 &&
    state.variancePoints <= 10
  const variancePoints = varianceEffective ? state.variancePoints : 0
  const hasAdd =
    tickedAddonKeys.length > 0 || variancePoints > 0 || state.shipVials > 0
  return {
    retest,
    carry,
    add: hasAdd
      ? {
          profiles: tickedAddonKeys,
          variance_points: variancePoints,
          additional_vials: state.shipVials,
        }
      : null,
    auto_checkin: state.autoCheckin,
    fee: state.fee,
    reason: state.reason.trim(),
  }
}

function initialState(options: RetestOptions): RetestFormState {
  const toggles: Record<string, boolean> = {}
  for (const p of options.profiles) toggles[p.key] = !p.carry_eligible
  return {
    toggles,
    addons: {},
    varianceTicked: false,
    variancePoints: 3,
    shipVials: 0,
    fee: 'paid',
    autoCheckin: false,
    reason: '',
  }
}

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
  // sample (it stays mounted like CancelSampleDialog, so closing must
  // not leave a stale reason / toggles / add-on ticks behind). Render-time
  // reset per React's "adjusting state when a prop changes" pattern, not
  // an effect, so this stays in sync without a cascading-render lint
  // violation.
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
            <DialogTitle>Retest {sampleId}</DialogTitle>
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

  const anyRetest = options.profiles.some(p => state.toggles[p.key])
  const anyAddon = options.addons.some(a => a.wp_type && state.addons[a.key])
  const sellableAddons = options.addons.filter(a => a.wp_type)
  const selectedAddons = sellableAddons.filter(a => state.addons[a.key])
  const hplcSetToRetest = options.profiles.some(
    p =>
      (HPLC_PROFILE_KEYS as readonly string[]).includes(p.key) &&
      state.toggles[p.key]
  )
  const varianceEffective =
    hplcSetToRetest &&
    state.varianceTicked &&
    state.variancePoints >= 2 &&
    state.variancePoints <= 10
  const hasSomethingToDo = anyRetest || anyAddon || varianceEffective
  const canCreate =
    state.reason.trim().length > 0 && hasSomethingToDo && !pending

  const feeApplies =
    anyRetest && state.fee === 'paid' && options.context != null
  const delta = options.prices_available
    ? retestDelta({
        addons: selectedAddons,
        variancePoints: varianceEffective ? state.variancePoints : 0,
        pointPrice: options.variance.point_price,
        retestFeePrice: feeApplies
          ? (options.context?.retest_fee?.price ?? null)
          : undefined,
      })
    : null

  const addingSomething = anyAddon || varianceEffective
  const title = anyRetest
    ? addingSomething
      ? 'Retest + add services'
      : `Retest ${sampleId}`
    : addingSomething
      ? `Add services to ${sampleId}`
      : `Retest ${sampleId}`

  function setToggle(key: string, toRetest: boolean) {
    setState(s =>
      s ? { ...s, toggles: { ...s.toggles, [key]: toRetest } } : s
    )
  }
  function setAddon(key: string, checked: boolean) {
    setState(s => (s ? { ...s, addons: { ...s.addons, [key]: checked } } : s))
  }

  function submit() {
    if (!state || !options) return
    mutation.mutate(buildRetestBody(state, options))
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-1 text-sm text-muted-foreground">
          <p>Creates a WP retest order against order {options.order_number}.</p>
          <p>When the order completes, Mk1 creates a new sample.</p>
          <p>
            Ticked services get new vials, the rest are carried as verified
            results linked to this sample; nothing changes on this sample or its
            COA.
          </p>
        </div>

        {options.context ? (
          <div
            data-testid="retest-context-block"
            className="rounded-md border border-border/40 p-3 space-y-1.5 text-sm"
          >
            {options.context.order ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    Order {options.context.order.number}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(
                      options.context.order.placed_at
                    ).toLocaleDateString()}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  {options.context.order.customer_name} ·{' '}
                  {options.context.order.customer_email}
                </div>
                <div>
                  {formatMoney(options.context.order.total)} ·{' '}
                  {options.context.order.status}
                </div>
                <ul className="text-xs text-muted-foreground space-y-0.5">
                  {options.context.order.lines.map(l => (
                    <li key={l.key}>
                      {l.label}: {formatMoney(l.price)}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-muted-foreground">Customer info unavailable</p>
            )}
            {options.context.pending_orders.length > 0 ? (
              <div className="pt-1.5 space-y-1">
                <div className="text-xs font-medium text-muted-foreground">
                  Pending retest orders
                </div>
                {options.context.pending_orders.map(o => (
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
                        className="underline text-muted-foreground"
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

        <div>
          {options.profiles.map(p => {
            const toRetest = Boolean(state.toggles[p.key])
            return (
              <div
                key={p.key}
                data-testid={`retest-row-${p.key}`}
                role="group"
                aria-label={p.name}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-2 py-1.5 border-b border-border/40"
              >
                <div>
                  <span>{p.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {p.state}
                  </span>
                  {!p.carry_eligible && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      Not verified on this sample; must be retested
                    </span>
                  )}
                </div>
                <Button
                  type="button"
                  variant={toRetest ? 'default' : 'outline'}
                  size="sm"
                  aria-pressed={toRetest}
                  onClick={() => setToggle(p.key, true)}
                >
                  Retest
                </Button>
                <Button
                  type="button"
                  variant={!toRetest ? 'default' : 'outline'}
                  size="sm"
                  aria-pressed={!toRetest}
                  disabled={!p.carry_eligible}
                  title={
                    p.carry_eligible
                      ? undefined
                      : 'Not verified on this sample; must be retested'
                  }
                  onClick={() => setToggle(p.key, false)}
                >
                  Carry
                </Button>
              </div>
            )
          })}
        </div>

        <div className="space-y-2">
          {sellableAddons.map(a => (
            <div key={a.key} className="flex items-center gap-2">
              <Checkbox
                id={`addon-${a.key}`}
                checked={Boolean(state.addons[a.key])}
                onCheckedChange={c => setAddon(a.key, c === true)}
              />
              <Label htmlFor={`addon-${a.key}`}>
                {a.name}{' '}
                {a.price === null
                  ? '(price unavailable)'
                  : `(${formatMoney(a.price)} · ${a.vials ?? 0} vials)`}
              </Label>
            </div>
          ))}

          {options.variance.allowed && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="variance-check"
                checked={state.varianceTicked}
                disabled={!hplcSetToRetest}
                onCheckedChange={c =>
                  setState(s => (s ? { ...s, varianceTicked: c === true } : s))
                }
              />
              <Label htmlFor="variance-check">Variance</Label>
              <Input
                type="number"
                min={2}
                max={10}
                value={state.variancePoints}
                disabled={!hplcSetToRetest || !state.varianceTicked}
                aria-label="Variance points"
                onChange={e =>
                  setState(s =>
                    s ? { ...s, variancePoints: Number(e.target.value) } : s
                  )
                }
                className="w-20"
              />
              {options.variance.point_price !== null && (
                <span className="text-xs text-muted-foreground">
                  @ {formatMoney(options.variance.point_price)}/point
                </span>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Label htmlFor="ship-vials">ship vials</Label>
            <Input
              id="ship-vials"
              type="number"
              min={0}
              max={20}
              value={state.shipVials}
              onChange={e =>
                setState(s =>
                  s ? { ...s, shipVials: Number(e.target.value) } : s
                )
              }
              className="w-20"
            />
          </div>

          <p className="text-sm">
            {delta === null
              ? 'Delta: price unavailable'
              : `Delta: ${formatMoney(delta)}`}
          </p>
        </div>

        {anyRetest && (
          <div>
            <p className="text-sm font-medium">Fee</p>
            <RadioGroup
              aria-label="Fee"
              value={state.fee}
              onValueChange={v =>
                setState(s => (s ? { ...s, fee: v as 'paid' | 'free' } : s))
              }
              className="flex gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem id="fee-paid" value="paid" />
                <Label htmlFor="fee-paid">
                  {typeof options.context?.retest_fee?.price === 'number'
                    ? `Paid (${formatMoney(options.context.retest_fee.price)})`
                    : 'Paid'}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="fee-free" value="free" />
                <Label htmlFor="fee-free">Free</Label>
              </div>
            </RadioGroup>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Switch
            id="auto-checkin"
            checked={state.autoCheckin}
            onCheckedChange={c =>
              setState(s => (s ? { ...s, autoCheckin: c } : s))
            }
          />
          <Label htmlFor="auto-checkin">Auto check-in</Label>
        </div>
        <p className="text-xs text-muted-foreground -mt-2">
          On: an extra vial on hand, the sample lands Received. Off: the sample
          lands Due, vials are seeded at check-in.
        </p>

        <div>
          <Label htmlFor="retest-reason">Reason</Label>
          <Textarea
            id="retest-reason"
            value={state.reason}
            onChange={e =>
              setState(s => (s ? { ...s, reason: e.target.value } : s))
            }
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canCreate}>
            {pending ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
