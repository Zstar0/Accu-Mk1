import { useEffect, useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import {
  fetchSubSamplePhotoUrl,
  type SubSample,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { vialPosition } from '@/lib/vial-label'
import { ROLE_BADGE_CLASS } from '@/lib/assignment-colors'
import { useUIStore } from '@/store/ui-store'
import { usePrintLabel } from '@/components/samples/usePrintLabel'
import { PrintLabelPortal } from '@/components/samples/PrintLabelPortal'

// Mirrors the role palette in VialsList.tsx and SenaiteDashboard.tsx — kept
// inline (third copy) to stay additive. Worth deduping into a shared module
// when there's appetite to touch all three call sites in one pass.
const ROLE_BADGES: Record<string, { label: string; cls: string }> = {
  hplc:       { label: 'HPLC',       cls: ROLE_BADGE_CLASS.hplc },
  endo:       { label: 'ENDO',       cls: ROLE_BADGE_CLASS.endo },
  ster:       { label: 'STERYL',     cls: ROLE_BADGE_CLASS.ster },
  xtra:       { label: 'XTRA',       cls: ROLE_BADGE_CLASS.xtra },
  unassigned: { label: 'Unassigned', cls: ROLE_BADGE_CLASS.unassigned },
}

function RoleBadge({ role }: { role: string | null | undefined }) {
  const b = ROLE_BADGES[role ?? 'unassigned'] ?? ROLE_BADGES.unassigned!
  return (
    <span
      className={cn(
        'inline-block text-[10px] leading-none px-1.5 py-0.5 rounded border uppercase tracking-wide font-medium',
        b.cls
      )}
      title={`Assigned to ${b.label}`}
    >
      {b.label}
    </span>
  )
}

interface Props {
  vials: { sub: SubSample; isThisSession: boolean }[]
  orderNumber: string | null
  onCloseAndNavigate: (sampleId: string) => void
  /** Container family: S01 IS Vial 1 (position = vial_sequence). */
  containerMode: boolean
}

/**
 * Photo cell — fetches via the authed proxy endpoint (Bearer header required,
 * so we can't use a plain <img src>). Falls back to a placeholder icon while
 * loading or on error.
 */
function SubSamplePhotoCell({
  sampleId,
  hasPhoto,
}: {
  sampleId: string
  hasPhoto: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [errored, setErrored] = useState(false)

  useEffect(() => {
    if (!hasPhoto) return
    let cancelled = false
    void fetchSubSamplePhotoUrl(sampleId)
      .then(u => {
        if (cancelled) return
        if (u) setUrl(u)
        else setErrored(true)
      })
      .catch(() => {
        if (!cancelled) setErrored(true)
      })
    return () => {
      cancelled = true
    }
  }, [sampleId, hasPhoto])

  if (!hasPhoto) return <span className="text-muted-foreground">—</span>
  if (errored || !url) {
    return (
      <span className="inline-flex w-12 h-12 rounded bg-muted text-muted-foreground items-center justify-center text-xs">
        <ImageIcon size={16} />
      </span>
    )
  }
  return (
    <img
      src={url}
      alt={`vial for ${sampleId}`}
      className="w-12 h-12 rounded object-cover"
    />
  )
}

export function VialDetailsTab({ vials, orderNumber, onCloseAndNavigate, containerMode }: Props) {
  const { printLabel, target: printTarget } = usePrintLabel()
  const subSamples = vials.map(v => v.sub)
  const subCount = subSamples.length

  return (
    <div className="overflow-y-auto h-full p-6 space-y-8">
      <section>
        <header className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold">
            Sub-Samples{subCount > 0 ? ` (${subCount})` : ''}
          </h2>
        </header>

        {subSamples.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sub-samples yet.</p>
        ) : (
          <div className="rounded border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr className="text-left">
                  <th className="px-3 py-2 w-16">Vial</th>
                  <th className="px-3 py-2">Sample ID</th>
                  <th className="px-3 py-2 w-24">Role</th>
                  <th className="px-3 py-2 w-28">Photo</th>
                  <th className="px-3 py-2 w-44">Received</th>
                  <th className="px-3 py-2 w-20">By</th>
                  <th className="px-3 py-2 w-32"></th>
                </tr>
              </thead>
              <tbody>
                {subSamples.map(s => (
                  <tr key={s.sample_id} className="border-t">
                    <td className="px-3 py-2 font-mono">{vialPosition(s.vial_sequence, containerMode)}</td>
                    <td className="px-3 py-2 font-mono">
                      <button
                        type="button"
                        onClick={() => onCloseAndNavigate(s.sample_id)}
                        className="underline hover:text-foreground text-left"
                      >
                        {s.sample_id}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <RoleBadge role={s.assignment_role} />
                    </td>
                    <td className="px-3 py-2">
                      <SubSamplePhotoCell
                        sampleId={s.sample_id}
                        hasPhoto={!!s.photo_external_uid}
                      />
                    </td>
                    <td className="px-3 py-2">
                      {new Date(s.received_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {s.received_by_user_id ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onCloseAndNavigate(s.sample_id)}
                        className="text-sm underline mr-3"
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        onClick={() => printLabel({
                          sampleId: s.sample_id,
                          orderNumber,
                          receivedAt: s.received_at,
                        })}
                        className="text-sm underline"
                      >
                        Print Label
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">Sub-Sample Analyses</h2>
        <p className="text-sm text-muted-foreground">
          Per-sub-sample analyses appear here once the worksheet vial-to-test
          assignment phase ships. No analyses are routed to sub-samples in v1.
        </p>
      </section>

      <PrintLabelPortal target={printTarget} />
    </div>
  )
}

// Helper hook to derive a navigate-then-close handler for callers.
export function useCloseAndNavigate(onClose: () => void) {
  const navigateToSample = useUIStore(s => s.navigateToSample)
  return (sampleId: string) => {
    onClose()
    navigateToSample(sampleId)
  }
}
