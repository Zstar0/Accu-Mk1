import { useEffect, useState } from 'react'
import { fetchSubSamplePhotoUrl, type SubSample } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Props {
  vials: { sub: SubSample; isThisSession: boolean }[]
  /** Parent AR rendered as Vial 1 in the single-vial check-in policy.
   * null = parent still pre-received. */
  parentVial: { sampleId: string; receivedThisSession: boolean } | null
  activeSampleId: string | null
  onSelect: (sampleId: string | null) => void
}

function VialThumb({ sampleId, hasPhoto }: { sampleId: string; hasPhoto: boolean }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!hasPhoto) {
      setUrl(null)
      return
    }
    let cancelled = false
    void fetchSubSamplePhotoUrl(sampleId)
      .then(u => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [sampleId, hasPhoto])

  return (
    <div className="w-9 h-9 rounded bg-muted/60 border shrink-0 overflow-hidden flex items-center justify-center">
      {url ? (
        <img
          src={url}
          alt=""
          className="w-full h-full object-cover"
        />
      ) : (
        <span className="text-[8px] text-muted-foreground">no photo</span>
      )}
    </div>
  )
}

export function VialsList({
  vials,
  parentVial,
  activeSampleId,
  onSelect,
}: Props) {
  return (
    <aside className="border-l bg-muted/20 p-3 overflow-y-auto h-full flex flex-col">
      <h3 className="text-sm font-semibold mb-2 uppercase tracking-wide text-muted-foreground">
        Vials
      </h3>

      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          'w-full text-left p-2 mb-3 rounded border-2 border-dashed transition-colors',
          activeSampleId === null
            ? 'border-primary text-primary bg-primary/5'
            : 'border-muted-foreground/40 hover:border-muted-foreground hover:bg-muted'
        )}
      >
        + New vial
      </button>

      <ul className="space-y-1 flex-1">
        {parentVial && (
          <li className="rounded bg-muted/30 opacity-80 p-2 flex items-center gap-2">
            {/* Photo endpoint falls back to the parent AR's last attachment
                when the sample_id isn't a sub-sample, so the same VialThumb
                works here. hasPhoto is true once the parent has been
                received — pre-receive parents won't have one yet. */}
            <VialThumb sampleId={parentVial.sampleId} hasPhoto={true} />
            <div className="min-w-0">
              <div className="font-mono text-sm truncate">{parentVial.sampleId}</div>
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <span>Vial 1</span>
                <span aria-hidden>·</span>
                <span>
                  {parentVial.receivedThisSession ? 'received' : 'previously received'}
                </span>
              </div>
            </div>
          </li>
        )}
        {vials.length === 0 && !parentVial && (
          <li className="text-xs text-muted-foreground px-2 py-1">
            No vials received yet.
          </li>
        )}
        {vials.map(v => {
          const isActive = activeSampleId === v.sub.sample_id
          const editable = v.isThisSession
          const hasPhoto = !!v.sub.photo_external_uid

          return (
            <li key={v.sub.sample_id} className="rounded overflow-hidden">
              {editable ? (
                <button
                  type="button"
                  onClick={() => onSelect(v.sub.sample_id)}
                  title="Edit this vial"
                  className={cn(
                    'w-full text-left p-2 rounded transition-colors flex items-center gap-2',
                    isActive
                      ? 'bg-primary/10 ring-1 ring-primary/30'
                      : 'hover:bg-muted'
                  )}
                >
                  <VialThumb sampleId={v.sub.sample_id} hasPhoto={hasPhoto} />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-sm truncate">{v.sub.sample_id}</div>
                    <div className="text-xs text-muted-foreground">
                      Vial {v.sub.vial_sequence + 1}
                    </div>
                    {v.sub.assignment_role && (
                      <span className="inline-block mt-1 text-[9px] px-1.5 py-0.5 rounded bg-muted/50 uppercase tracking-wide font-mono">
                        {v.sub.assignment_role === 'ster' ? 'STERYL' : v.sub.assignment_role.toUpperCase()}
                      </span>
                    )}
                  </div>
                </button>
              ) : (
                <div className="rounded bg-muted/30 opacity-70 p-2 flex items-center gap-2">
                  <VialThumb sampleId={v.sub.sample_id} hasPhoto={hasPhoto} />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-sm truncate">{v.sub.sample_id}</div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <span>Vial {v.sub.vial_sequence}</span>
                      <span aria-hidden>·</span>
                      <span>read-only</span>
                    </div>
                    {v.sub.assignment_role && (
                      <span className="inline-block mt-1 text-[9px] px-1.5 py-0.5 rounded bg-muted/50 uppercase tracking-wide font-mono">
                        {v.sub.assignment_role === 'ster' ? 'STERYL' : v.sub.assignment_role.toUpperCase()}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
