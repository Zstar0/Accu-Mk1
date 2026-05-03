import { useState } from 'react'
import { Printer, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useReceiveWizard, type ParentInfo } from './useReceiveWizard'
import { useParentSampleDetails } from './useParentSampleDetails'
import { WizardSidebar } from './WizardSidebar'
import { VialPanel } from './VialPanel'
import { PrintStep } from './PrintStep'

interface Props {
  parent: ParentInfo
  onClose: () => void
}

type Phase = 'capture' | 'print'

export function ReceiveWizard({ parent, onClose }: Props) {
  const wiz = useReceiveWizard(parent)
  const parentDetails = useParentSampleDetails(parent.sample_id)
  const [phase, setPhase] = useState<Phase>('capture')
  const [editingSampleId, setEditingSampleId] = useState<string | null>(null)

  if (phase === 'print') {
    // Print list = parent (if received this session) + sub-samples added this
    // session. Parent's label leads because it's vial 1 in the new policy.
    const printList = wiz.parentReceivedThisSession
      ? [{ sample_id: parent.sample_id }, ...wiz.sessionVials]
      : wiz.sessionVials
    return (
      <PrintStep
        vials={printList}
        orderNumber={parentDetails.details?.client_order_number ?? null}
        onDone={onClose}
      />
    )
  }

  const editingSub = editingSampleId
    ? (wiz.vials.find(v => v.sub.sample_id === editingSampleId)?.sub ?? null)
    : null

  // Print labels enabled when ANY save happened this session — either the
  // parent was just received (single-vial check-in) or one or more sub-sample
  // vials were added.
  const hasSessionVials = wiz.sessionVials.length > 0 || wiz.parentReceivedThisSession

  return (
    <div className="grid grid-rows-[1fr_auto] h-full min-h-[500px]">
      <div className="grid grid-cols-[260px_1fr] min-h-0 overflow-hidden">
        <WizardSidebar
          vials={wiz.vials}
          parentVial={
            wiz.parentReceived
              ? {
                  sampleId: parent.sample_id,
                  receivedThisSession: wiz.parentReceivedThisSession,
                }
              : null
          }
          activeSampleId={editingSampleId}
          onSelect={setEditingSampleId}
          parentDetails={parentDetails.details}
          parentDetailsLoading={parentDetails.loading}
          parentDetailsError={parentDetails.error}
        />
        <VialPanel
          parentSampleId={parent.sample_id}
          parentDetails={parentDetails.details}
          editingSub={editingSub}
          loading={wiz.loading}
          error={wiz.error}
          onSaveNew={async (photoBytes: Uint8Array, remarks?: string) => {
            const sub = await wiz.saveNewVial(photoBytes, remarks)
            setEditingSampleId(null)
            return sub
          }}
          onSaveEdit={async (
            sid: string,
            photoBytes?: Uint8Array,
            remarks?: string
          ) => {
            await wiz.editSessionVial(sid, photoBytes, remarks)
            setEditingSampleId(null)
          }}
          onDelete={async (sid: string) => {
            await wiz.deleteSessionVial(sid)
            setEditingSampleId(null)
          }}
        />
      </div>
      <footer className="flex justify-end gap-2 px-6 py-3 border-t bg-muted/20 transition-colors">
        <Button
          type="button"
          variant="outline"
          onClick={() => setPhase('print')}
          disabled={!hasSessionVials}
          title={
            hasSessionVials ? undefined : 'Save at least one vial first'
          }
          className="disabled:opacity-50"
        >
          <Printer className="w-4 h-4" aria-hidden="true" />
          Print labels
        </Button>
        <Button type="button" onClick={onClose}>
          <Check className="w-4 h-4" aria-hidden="true" />
          Finished
        </Button>
      </footer>
    </div>
  )
}
