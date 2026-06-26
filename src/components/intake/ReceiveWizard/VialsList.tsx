import { useEffect, useState } from 'react'
import { fetchSubSamplePhotoUrl, type SubSample } from '@/lib/api'
import { cn } from '@/lib/utils'
import { vialLabel } from '@/lib/vial-label'
import { ROLE_BADGE_CLASS } from '@/lib/assignment-colors'

interface Props {
  vials: { sub: SubSample; isThisSession: boolean }[]
  /** Parent AR rendered as Vial 1 in the single-vial check-in policy.
   * null = parent still pre-received. */
  parentVial: {
    sampleId: string
    receivedThisSession: boolean
    assignmentRole: string | null
  } | null
  activeSampleId: string | null
  onSelect: (sampleId: string | null) => void
  /** Container family: S01 IS Vial 1 (no parent entry, label = vial_sequence). */
  containerMode: boolean
}

// Role badge palette — uses the same tint family as SenaiteDashboard.tsx
// (sky/emerald/violet/zinc/amber) but with full labels instead of letters
// since the wizard's right column has the space for it.
const ROLE_BADGES: Record<string, { label: string; cls: string }> = {
  hplc:       { label: 'HPLC',       cls: ROLE_BADGE_CLASS.hplc },
  endo:       { label: 'ENDO',       cls: ROLE_BADGE_CLASS.endo },
  ster:       { label: 'PCR',        cls: ROLE_BADGE_CLASS.ster },
  xtra:       { label: 'XTRA',       cls: ROLE_BADGE_CLASS.xtra },
  unassigned: { label: 'Unassigned', cls: ROLE_BADGE_CLASS.unassigned },
}

function RoleBadge({ role }: { role: string | null | undefined }) {
  const b = ROLE_BADGES[role ?? 'unassigned'] ?? ROLE_BADGES.unassigned!
  return (
    <span
      className={cn(
        'inline-block mt-1 text-[10px] leading-none px-1.5 py-0.5 rounded border uppercase tracking-wide font-medium',
        b.cls
      )}
      title={`Assigned to ${b.label}`}
    >
      {b.label}
    </span>
  )
}

function VialThumb({
  sampleId,
  hasPhoto,
  photoKey,
}: {
  sampleId: string
  hasPhoto: boolean
  // photo_external_uid — changes when the photo is retaken, so the fetch effect
  // re-runs and re-reads the (reseeded) cache instead of showing the stale shot.
  photoKey?: string | null
}) {
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
  }, [sampleId, hasPhoto, photoKey])

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
  containerMode,
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
            <div className="min-w-0 flex-1">
              <div className="font-mono text-sm truncate">{parentVial.sampleId}</div>
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <span>Vial 1</span>
                <span aria-hidden>·</span>
                <span>
                  {parentVial.receivedThisSession ? 'received' : 'previously received'}
                </span>
              </div>
              <RoleBadge role={parentVial.assignmentRole} />
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
          const hasPhoto = !!v.sub.photo_external_uid

          // Every sub-sample vial is editable — click to retake the photo or
          // edit remarks (prior-session vials included; the edit flow PATCHes
          // by sample_id and isn't session-bound). Only the parent AR card
          // (rendered above, container families excepted) stays display-only.
          return (
            <li key={v.sub.sample_id} className="rounded overflow-hidden">
              <button
                type="button"
                onClick={() => onSelect(v.sub.sample_id)}
                title="Edit this vial — retake photo or edit remarks"
                className={cn(
                  'w-full text-left p-2 rounded transition-colors flex items-center gap-2',
                  isActive
                    ? 'bg-primary/10 ring-1 ring-primary/30'
                    : 'hover:bg-muted'
                )}
              >
                <VialThumb sampleId={v.sub.sample_id} hasPhoto={hasPhoto} photoKey={v.sub.photo_external_uid} />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm truncate">{v.sub.sample_id}</div>
                  <div className="text-xs text-muted-foreground">
                    {vialLabel(v.sub.vial_sequence, containerMode)}
                  </div>
                  <RoleBadge role={v.sub.assignment_role} />
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
