import { useQuery } from '@tanstack/react-query'
import { RefreshCw, Copy, FlaskConical } from 'lucide-react'
import {
  getOrderedProducts, OrderedProductsError,
  type OrderedProduct, type SubSampleListResponse,
} from '@/lib/api'

function Chip({ p }: { p: OrderedProduct }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-1 text-xs text-violet-300">
      <FlaskConical size={12} /> {p.label}
    </span>
  )
}

export function OrderedProducts({
  sampleId, subData,
}: { sampleId: string; subData: SubSampleListResponse | undefined }) {
  // subData is passed to Task 6's purchased-vs-assigned alert (insertion point below).
  void subData

  const q = useQuery({
    queryKey: ['ordered-products', sampleId],
    queryFn: () => getOrderedProducts(sampleId),
    retry: (count, err) => !(err instanceof OrderedProductsError && err.status === 404) && count < 2,
    retryDelay: 0,
  })

  const Header = (
    <span className="text-[11px] text-muted-foreground uppercase tracking-wider">Products</span>
  )

  if (q.isLoading) {
    return <Section header={Header}><span className="text-xs text-muted-foreground">loading…</span></Section>
  }

  if (q.isError) {
    const err = q.error
    if (err instanceof OrderedProductsError && err.status === 404) {
      return <Section header={Header}><span className="text-xs text-muted-foreground">no linked order</span></Section>
    }
    const errorText = formatError(sampleId, err)
    return (
      <Section header={Header}>
        <div className="flex items-center gap-2">
          <span className="text-xs text-red-400" title={errorText}>⚠ Couldn&apos;t load ordered products</span>
          <button
            className="text-xs text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1"
            onClick={() => navigator.clipboard?.writeText(errorText)}
          >
            <Copy size={12} /> Copy
          </button>
          <button
            className="text-xs text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1"
            onClick={() => q.refetch()}
          >
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      </Section>
    )
  }

  const products = q.data?.products ?? []
  return (
    <Section header={Header}>
      <div className="flex flex-wrap gap-2">
        {products.map(p => <Chip key={p.key} p={p} />)}
      </div>
      {/* Task 6 inserts the purchased-vs-assigned alert here, using `subData`. */}
    </Section>
  )
}

function Section({ header, children }: { header: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-3 pt-3 border-t border-border">
      {header}
      <div className="mt-2">{children}</div>
    </div>
  )
}

function formatError(sampleId: string, err: unknown): string {
  const e = err as OrderedProductsError
  const status = e?.status ?? '?'
  const detail = typeof e?.detail === 'string' ? e.detail : JSON.stringify(e?.detail ?? {})
  return `ordered-products error\nsample_id: ${sampleId}\nstatus: ${status}\ndetail: ${detail}\nat: ${new Date().toISOString()}`
}
