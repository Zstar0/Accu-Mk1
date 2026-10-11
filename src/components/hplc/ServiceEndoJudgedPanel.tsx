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
} from '@/lib/endo-prep-2ml'
import { allowedCartridges, runParamsFrom } from '@/lib/endo-worksheet-2ml'
import { useUIStore } from '@/store/ui-store'
import { ruleLabel, tierChip } from './ServiceSpecsSection'

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
  const methodsQ = useQuery({
    queryKey: ['hplc-methods'],
    queryFn: getMethods,
    staleTime: 5 * 60_000,
    enabled: methodId !== null,
  })
  const methodLinksQ = useQuery({
    queryKey: ['hplc-methods', methodId, 'consumables'],
    queryFn: () => getMethodConsumables(methodId ?? 0),
    enabled: methodId !== null,
  })
  // Retired types included, so a method whose links are all retired is
  // told apart from one that links none (4.3).
  const catalogQ = useQuery({
    queryKey: ['consumables', 'endo_cartridge'],
    queryFn: () => listConsumables({ kind: 'endo_cartridge' }),
    staleTime: 5 * 60_000,
  })

  // Until these settle, the defaults would read as the method's own numbers.
  const needed =
    methodId === null
      ? [specsQ, linksQ, catalogQ]
      : [specsQ, linksQ, catalogQ, methodsQ, methodLinksQ]
  // A failed refetch with data on hand keeps showing that data.
  const failed = needed.filter(q => q.isError && q.data === undefined)
  const loading = needed.some(q => q.isPending)

  const catalog = catalogQ.data ?? []
  const method = methodsQ.data?.find(m => m.id === methodId) ?? null
  // Every endo link joined to the catalog, retired ones included: the shape
  // the server's _method_payload serves the worksheet as endo_method.
  const linked = (methodLinksQ.data ?? []).flatMap(l => {
    const c = catalog.find(x => x.id === l.consumable_type_id)
    return c?.kind === 'endo_cartridge'
      ? [
          {
            id: c.id,
            name: c.name,
            sensitivity_eu_ml: Number(c.specs.sensitivity_eu_ml),
            is_default: l.is_default,
            active: c.active,
          },
        ]
      : []
  })
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
  const allowed = allowedCartridges({ endo_method: info }, catalog)
  // The run cartridge a worksheet falls back to (runCartridgeFor).
  const dflt = allowed.find(c => c.is_default) ?? null
  const tiers = (specsQ.data ?? []).filter(s => s.active)
  const ui = useUIStore.getState

  return (
    <div className="border-t pt-4">
      <h4 className="mb-3 text-sm font-semibold text-muted-foreground">
        How results are judged
      </h4>
      {failed.length > 0 ? (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>Couldn&apos;t load how results are judged.</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => failed.forEach(q => void q.refetch())}
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
                        <Badge variant="outline" className="text-xs">
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
                  dflt
                    ? `: ${fmt(dflt.sensitivity_eu_ml)} × ${fmt(p.stdTotalDilution)} × ${fmt(p.reconWaterMl)} mL = ${fmt(dflt.sensitivity_eu_ml * p.stdTotalDilution * p.reconWaterMl)} EU per vial at the standard prep`
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
