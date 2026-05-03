import type { SenaiteLookupResult, SubSample } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { cn } from '@/lib/utils'
import { SampleInfoPanel } from './SampleInfoPanel'

interface WizardSidebarProps {
  vials: { sub: SubSample; isThisSession: boolean }[]
  /** Parent AR rendered as Vial 1 in the new single-vial check-in policy.
   * Shown read-only above the sub-sample list whenever the parent has been
   * received (this session or previously). null = parent still pre-received. */
  parentVial: { sampleId: string; receivedThisSession: boolean } | null
  activeSampleId: string | null
  onSelect: (sampleId: string | null) => void
  parentDetails: SenaiteLookupResult | null
  parentDetailsLoading: boolean
  parentDetailsError: string | null
}

export function WizardSidebar({
  vials,
  parentVial,
  activeSampleId,
  onSelect,
  parentDetails,
  parentDetailsLoading,
  parentDetailsError,
}: WizardSidebarProps) {
  const navigateToSample = useUIStore(state => state.navigateToSample)

  return (
    <aside className="border-r bg-muted/20 p-3 overflow-y-auto h-full flex flex-col">
      <SampleInfoPanel
        details={parentDetails}
        loading={parentDetailsLoading}
        error={parentDetailsError}
      />

      <div className="-mx-3 mb-3 border-t" />

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
        {/* Parent AR represents Vial 1 under the single-vial check-in policy.
            Read-only here — edits to the parent's photo/remarks happen on
            the main sample detail page, not inside the receive wizard.
            Mirrors the prior-session sub-sample pattern: the entry shows
            sample id + status, with a "View details" link below that
            navigates to the parent's detail page. */}
        {parentVial && (
          <li className="rounded overflow-hidden">
            <div className="rounded bg-muted/30">
              <div className="text-left p-2 opacity-80">
                <div className="font-mono text-sm">{parentVial.sampleId}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  <span>Vial 1</span>
                  <span aria-hidden>·</span>
                  <span>
                    {parentVial.receivedThisSession ? 'received' : 'previously received'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => navigateToSample(parentVial.sampleId)}
                className="w-full text-left text-xs underline px-2 pb-2 text-muted-foreground hover:text-foreground transition-colors"
              >
                View details
              </button>
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

          return (
            <li key={v.sub.sample_id} className="rounded overflow-hidden">
              {editable ? (
                <button
                  type="button"
                  onClick={() => onSelect(v.sub.sample_id)}
                  title="Edit this vial"
                  className={cn(
                    'w-full text-left p-2 rounded transition-colors',
                    isActive
                      ? 'bg-primary/10 ring-1 ring-primary/30'
                      : 'hover:bg-muted'
                  )}
                >
                  <div className="font-mono text-sm">{v.sub.sample_id}</div>
                  <div className="text-xs text-muted-foreground">
                    {/* Parent is Vial 1; sub-samples are vials 2+ */}
                    Vial {v.sub.vial_sequence + 1}
                  </div>
                  {v.sub.assignment_role && (
                    <span className="inline-block mt-1 text-[9px] px-1.5 py-0.5 rounded bg-muted/50 uppercase tracking-wide font-mono">
                      {v.sub.assignment_role === 'ster' ? 'STERYL' : v.sub.assignment_role.toUpperCase()}
                    </span>
                  )}
                </button>
              ) : (
                <div className="rounded bg-muted/30">
                  <div className="text-left p-2 opacity-70 cursor-not-allowed">
                    <div className="font-mono text-sm">{v.sub.sample_id}</div>
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
                  <button
                    type="button"
                    onClick={() => navigateToSample(v.sub.sample_id)}
                    className="w-full text-left text-xs underline px-2 pb-2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    View details
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
