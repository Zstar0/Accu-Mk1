import { useEffect, useState } from 'react'
import {
  usePeptideRequest,
  usePeptideRequestHistory,
  useUpdatePeptideRequest,
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
  // Inner component so the mutation hook sees the guaranteed-present id.
  return <PeptideRequestDetailInner id={id} r={r} history={history} />
}

interface InnerProps {
  id: string
  r: import('@/types/peptide-request').PeptideRequest
  history: ReturnType<typeof usePeptideRequestHistory>
}

function PeptideRequestDetailInner({ id, r, history }: InnerProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>(r.sample_id ?? '')
  const [saveWarning, setSaveWarning] = useState<string | null>(null)
  const update = useUpdatePeptideRequest(id)

  // Keep draft in sync when the server row changes (e.g. after invalidate).
  useEffect(() => {
    setDraft(r.sample_id ?? '')
  }, [r.sample_id])

  const commit = () => {
    const next = draft.trim()
    const payload = next === '' ? null : next
    if (payload === (r.sample_id ?? null)) {
      setEditing(false)
      return
    }
    update.mutate(
      { sample_id: payload },
      {
        onSuccess: data => {
          setSaveWarning(data.warning ?? null)
          setEditing(false)
        },
      },
    )
  }

  const cancel = () => {
    setDraft(r.sample_id ?? '')
    setEditing(false)
  }

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
          <dt>Sample ID</dt>
          <dd>
            {editing ? (
              <span className="inline-flex items-center gap-2">
                <input
                  type="text"
                  value={draft}
                  autoFocus
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commit()
                    if (e.key === 'Escape') cancel()
                  }}
                  aria-label="Sample ID"
                  className="border rounded px-2 py-1 text-sm"
                  disabled={update.isPending}
                />
                <button
                  type="button"
                  onClick={commit}
                  disabled={update.isPending}
                  className="text-xs underline"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={cancel}
                  disabled={update.isPending}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-left hover:underline"
                aria-label="Edit Sample ID"
              >
                {r.sample_id ?? (
                  <span className="text-muted-foreground">— click to add</span>
                )}
              </button>
            )}
            {saveWarning && (
              <p className="text-xs text-amber-600 mt-1" role="alert">
                {saveWarning}
              </p>
            )}
            {update.isError && (
              <p className="text-xs text-destructive mt-1" role="alert">
                Failed to save. Try again.
              </p>
            )}
          </dd>
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
