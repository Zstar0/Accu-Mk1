import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  getMethodConsumables,
  getMethods,
  getServiceMethods,
  listConsumables,
  listServiceSpecs,
  type AnalysisServiceRecord,
  type EndoMethodInfo,
} from '@/lib/api'
import { fmt } from '@/lib/endo-prep'
import {
  BW_DILUTION,
  BW_LIMIT_EU_PER_ML,
  LIMIT_EU_PER_VIAL,
  prep2Check,
} from '@/lib/endo-prep-2ml'
import { allowedCartridges, runParamsFrom } from '@/lib/endo-worksheet-2ml'
import { useUIStore } from '@/store/ui-store'
import { ruleLabel, tierChip } from './ServiceSpecsSection'
import { SampleFormIconById } from '@/components/common/SampleFormIcon'

const SUB =
  'mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground'
const LINK =
  'rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * "How results are judged" (spec 2026-10-10 6.7), read-only, on an endotoxin
 * service's detail: the spec tiers as configured, the worksheet's rules (LOD,
 * LOQ, validity, the working limits) with the resolved method's numbers, and
 * the method and the cartridges a worksheet offers, with links to their
 * admin pages. Shows nothing, and fetches nothing, for any other service.
 */
export function ServiceEndoJudgedPanel({
  service,
}: {
  service: AnalysisServiceRecord
}) {
  if (!/ENDO/i.test(service.keyword ?? '')) return null
  return <EndoJudged serviceId={service.id} />
}

/** The cartridge rule as allowedCartridges (and the server's
 *  cartridge_ids_allowed_by) applies it. */
function cartridgeRule(info: EndoMethodInfo | null, offered: boolean): string {
  if (info && info.cartridges.length > 0)
    return offered
      ? 'Worksheets offer the active cartridges this revision links:'
      : 'Every cartridge this revision links is retired, so worksheets offer none until a new revision links an active one.'
  const who = info
    ? 'This revision links no cartridges, so worksheets'
    : 'Worksheets'
  return offered
    ? `${who} offer every active endotoxin cartridge:`
    : `${who} offer every active endotoxin cartridge, and the catalog has none yet.`
}

function EndoJudged({ serviceId }: { serviceId: number }) {
  const specsQ = useQuery({
    queryKey: ['analysis-services', serviceId, 'specs'],
    queryFn: () => listServiceSpecs(serviceId),
    staleTime: 60_000,
  })
  const linksQ = useQuery({
    queryKey: ['analysis-services', serviceId, 'methods'],
    queryFn: () => getServiceMethods(serviceId),
    staleTime: 60_000,
  })
  // The resolved method (spec 4.1): the service's active default.
  const link =
    linksQ.data?.find(l => l.is_default && l.status === 'active') ?? null
  const methodId = link?.method_id ?? null
  // Shared with the worksheet page and drawer, and nothing invalidates it,
  // so it is refetched on every mount: a revision activated or edited since
  // is read fresh. Enabled from mount, because refetchOnMount does not apply
  // to a query enabled later.
  const methodsQ = useQuery({
    queryKey: ['hplc-methods'],
    queryFn: getMethods,
    staleTime: 5 * 60_000,
    refetchOnMount: 'always',
  })
  // Only this panel reads it. staleTime 0 refetches it when the method id
  // first resolves, where refetchOnMount does not apply.
  const methodLinksQ = useQuery({
    queryKey: ['hplc-methods', methodId, 'consumables'],
    queryFn: () => getMethodConsumables(methodId ?? 0),
    enabled: methodId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
  })
  // The method's endo cartridges from the link rows themselves (name, specs,
  // active), retired ones included: the shape the server's _method_payload
  // serves the worksheet as endo_method.
  const linked = (methodLinksQ.data ?? [])
    .filter(l => l.kind === 'endo_cartridge')
    .map(l => ({
      id: l.consumable_type_id,
      name: l.name ?? '',
      sensitivity_eu_ml: Number(l.specs?.sensitivity_eu_ml),
      is_default: l.is_default,
      active: l.active === true,
    }))
  // The catalog only answers "every active endo cartridge" (4.3): no method,
  // or a method that links none.
  const needCatalog =
    methodId === null || (methodLinksQ.data !== undefined && !linked.length)
  const catalogQ = useQuery({
    queryKey: ['consumables', 'endo_cartridge'],
    queryFn: () => listConsumables({ kind: 'endo_cartridge' }),
    staleTime: 5 * 60_000,
    enabled: needCatalog,
  })

  const method = methodsQ.data?.find(m => m.id === methodId) ?? null
  // A methods list older than the links that name a method it lacks (a
  // revision activated in between) is refetched once. It cannot loop: after
  // the refetch, or a failed one, the list is no older than the links.
  const listPredatesLink =
    methodId !== null &&
    method === null &&
    methodsQ.data !== undefined &&
    methodsQ.dataUpdatedAt < linksQ.dataUpdatedAt &&
    methodsQ.errorUpdatedAt < linksQ.dataUpdatedAt
  const { isFetching: methodsFetching, refetch: refetchMethods } = methodsQ
  useEffect(() => {
    if (listPredatesLink && !methodsFetching) void refetchMethods()
  }, [listPredatesLink, methodsFetching, refetchMethods])

  // Until these settle, the defaults would read as the method's own numbers.
  const needed = [
    specsQ,
    linksQ,
    ...(methodId === null ? [] : [methodsQ, methodLinksQ]),
    ...(needCatalog ? [catalogQ] : []),
  ]
  // A failed refetch with data on hand keeps showing that data.
  const failed = needed.filter(q => q.isError && q.data === undefined)
  const loading =
    needed.some(q => q.isPending) ||
    (methodId !== null &&
      (methodsFetching || methodLinksQ.isFetching || listPredatesLink))
  // Still missing from a list fetched after the links: say so, rather than
  // show the standard parameters under this revision's name.
  const missing = link !== null && method === null

  // The same EndoMethodInfo the worksheet resolves, so the numbers and the
  // cartridges here come from the same runParamsFrom and allowedCartridges.
  const info: EndoMethodInfo | null = method
    ? {
        id: method.id,
        name: method.name,
        revision: method.revision,
        status: method.status,
        run_parameters: method.run_parameters ?? null,
        cartridges: linked,
      }
    : null
  const p = runParamsFrom(info)
  const allowed = allowedCartridges({ endo_method: info }, catalogQ.data ?? [])
  // The run cartridge a worksheet falls back to (runCartridgeFor), worked
  // through the worksheet's own check on a standard powder vial.
  const dflt = allowed.find(c => c.is_default) ?? null
  const std = dflt
    ? prep2Check(
        {
          sampleId: '',
          identity: '',
          sampleType: null,
          weightMg: null,
          form: 'powder',
          waterMl: null,
          totalDilution: null,
          steps: null,
          lambda: dflt.sensitivity_eu_ml,
          reading: null,
          reader: null,
        },
        { params: p, allowedLambdas: allowed.map(c => c.sensitivity_eu_ml) }
      )
    : null
  const tiers = (specsQ.data ?? []).filter(s => s.active)
  const ui = useUIStore.getState

  const problem =
    failed.length > 0
      ? "Couldn't load how results are judged."
      : !loading && missing && link
        ? `Couldn't find ${link.name} · Rev ${link.revision}, this service's default method, in the methods list, so its numbers are not shown.`
        : null

  return (
    <div className="border-t pt-4">
      <h4 className="mb-3 text-sm font-semibold text-muted-foreground">
        How results are judged
      </h4>
      {problem ? (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{problem}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              failed.length > 0
                ? failed.forEach(q => void q.refetch())
                : void refetchMethods()
            }
          >
            Retry
          </Button>
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <section>
            <h5 className={SUB}>Spec tiers (what the COA uses today)</h5>
            {tiers.length === 0 ? (
              <p className="text-muted-foreground">No specs yet.</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 font-medium">Sample type</th>
                    <th className="py-1 font-medium">Unit</th>
                    <th className="py-1 font-medium">Limit</th>
                    <th className="py-1 font-medium">Fixed LOQ</th>
                  </tr>
                </thead>
                <tbody>
                  {tiers.map(s => (
                    <tr key={s.id} className="border-t">
                      <td className="py-1.5">
                        <Badge variant="outline" className="gap-1 text-xs">
                          {s.sample_form_id != null && (
                            <SampleFormIconById
                              id={s.sample_form_id}
                              className="size-3.5"
                            />
                          )}
                          {tierChip(s)}
                        </Badge>
                      </td>
                      <td className="py-1.5 font-mono">{s.unit ?? '-'}</td>
                      <td className="py-1.5 font-mono">
                        {ruleLabel({ ...s, loq: null })}
                      </td>
                      <td className="py-1.5 font-mono">{s.loq ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h5 className={SUB}>On the endotoxin worksheet (2 mL prep)</h5>
            <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1.5">
              <dt className="text-muted-foreground">LOD</dt>
              <dd>
                The cartridge&apos;s sensitivity (λ), EU/mL; the dilution does
                not change it.
              </dd>
              <dt className="text-muted-foreground">LOQ</dt>
              <dd>
                {`λ × total dilution × water, EU per vial${
                  std?.loqVial != null
                    ? `: ${fmt(std.lambda)} × ${fmt(std.dilution)} × ${fmt(std.water)} mL = ${fmt(std.loqVial)} EU per vial at the standard prep`
                    : ''
                }. Bac water: λ × ${fmt(BW_DILUTION)}, EU/mL.`}
              </dd>
              <dt className="text-muted-foreground">Valid test</dt>
              <dd>
                {`spike recovery ${p.spikeRecoveryMinPct} to ${p.spikeRecoveryMaxPct} % and both CVs at most ${p.cvLimitPct} %; otherwise the verdict is Invalid and nothing goes to Accu-Mk1.`}
              </dd>
              <dt className="text-muted-foreground">Working limits</dt>
              <dd className="flex flex-wrap items-center gap-2">
                {`${LIMIT_EU_PER_VIAL} EU per vial (peptides), ${fmt(BW_LIMIT_EU_PER_ML)} EU/mL (bac water)`}
                <Badge variant="secondary" className="text-[10px]">
                  not yet the COA spec
                </Badge>
              </dd>
            </dl>
          </section>

          <section className="space-y-1.5">
            <h5 className={SUB}>Method</h5>
            {link ? (
              <button
                type="button"
                className={LINK}
                onClick={() => ui().navigateToMethod(link.method_id)}
              >
                {`${link.name} · Rev ${link.revision}`}
              </button>
            ) : (
              <p className="text-muted-foreground">
                No active default method covers this service, so worksheets use
                the standard run parameters.
              </p>
            )}
            <p className="text-muted-foreground">
              {cartridgeRule(info, allowed.length > 0)}
            </p>
            {allowed.length > 0 && (
              <ul className="space-y-1">
                {allowed.map(c => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={LINK}
                      onClick={() => ui().navigateTo('lims', 'consumables')}
                    >
                      {c.name}
                    </button>
                    <span className="font-mono text-xs">
                      {`${fmt(c.sensitivity_eu_ml)} EU/mL`}
                    </span>
                    {c.is_default && (
                      <Badge variant="secondary" className="text-[10px]">
                        Default
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

export default ServiceEndoJudgedPanel
