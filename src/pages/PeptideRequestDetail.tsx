import {
  usePeptideRequest,
  usePeptideRequestHistory,
} from '@/hooks/peptide-requests'
import { StatusTimeline } from '@/components/status-timeline'
import { useUIStore } from '@/store/ui-store'

export function PeptideRequestDetail() {
  const id = useUIStore(s => s.peptideRequestTargetId ?? '')
  const req = usePeptideRequest(id)
  const history = usePeptideRequestHistory(id)

  if (req.isLoading) return <p className="p-6">Loading…</p>
  if (!req.data) return <p className="p-6">Not found.</p>

  const r = req.data

  return (
    <div className="p-6 max-w-4xl">
      <button
        type="button"
        className="text-sm text-muted-foreground hover:underline mb-4"
        onClick={() => useUIStore.getState().setActiveSubSection('list')}
      >
        ← Back to list
      </button>

      <h1 className="text-2xl font-semibold">{r.compound_name}</h1>
      <div className="text-sm text-muted-foreground mb-6">
        {r.compound_kind} · {r.vendor_producer} · submitted by{' '}
        {r.submitted_by_name}
      </div>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Submission</h2>
        <dl className="grid grid-cols-[150px_1fr] gap-2 text-sm">
          <dt>Sequence/structure</dt>
          <dd>{r.sequence_or_structure ?? '—'}</dd>
          <dt>Molecular weight</dt>
          <dd>{r.molecular_weight ?? '—'}</dd>
          <dt>CAS / reference</dt>
          <dd>{r.cas_or_reference ?? '—'}</dd>
          <dt>Vendor catalog #</dt>
          <dd>{r.vendor_catalog_number ?? '—'}</dd>
          <dt>Reason / notes</dt>
          <dd>{r.reason_notes ?? '—'}</dd>
          <dt>Expected monthly volume</dt>
          <dd>{r.expected_monthly_volume ?? '—'}</dd>
          {r.sample_id && (
            <>
              <dt>Linked sample</dt>
              <dd>{r.sample_id}</dd>
            </>
          )}
        </dl>
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Links</h2>
        {r.clickup_task_id ? (
          <a
            href={`https://app.clickup.com/t/${r.clickup_task_id}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Open in ClickUp
          </a>
        ) : (
          <p className="text-sm text-muted-foreground">
            No ClickUp task linked.
          </p>
        )}
      </section>

      {r.status === 'rejected' && r.rejection_reason && (
        <section className="mb-6 rounded border border-destructive/30 bg-destructive/5 p-4">
          <h3 className="font-semibold mb-1">Rejection reason</h3>
          <p>{r.rejection_reason}</p>
        </section>
      )}

      {r.status === 'completed' && (
        <section className="mb-6 rounded border border-green-500/30 bg-green-500/5 p-4">
          <h3 className="font-semibold mb-1">Completion</h3>
          {r.wp_coupon_code && (
            <p>
              Coupon issued: <code>{r.wp_coupon_code}</code>
            </p>
          )}
          {r.senaite_service_uid && (
            <p>
              SENAITE service: <code>{r.senaite_service_uid}</code>
            </p>
          )}
          {r.compound_kind === 'other' && !r.senaite_service_uid && (
            <p className="text-amber-600">
              ⚠ Manual catalog setup required for non-peptide compound.
            </p>
          )}
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-2">Status timeline</h2>
        <StatusTimeline
          entries={history.data ?? []}
          currentStatus={r.status}
        />
      </section>
    </div>
  )
}
