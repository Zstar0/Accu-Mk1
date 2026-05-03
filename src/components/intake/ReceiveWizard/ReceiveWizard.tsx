import { useState } from 'react'
import { Printer, Check, ArrowRight, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useReceiveWizard, type ParentInfo } from './useReceiveWizard'
import { useParentSampleDetails } from './useParentSampleDetails'
import { WizardSidebar } from './WizardSidebar'
import { VialPanel } from './VialPanel'
import { PrintStep } from './PrintStep'
import { AssignStep } from './AssignStep'

interface Props {
  parent: ParentInfo
  onClose: () => void
}

type Phase = 'capture' | 'assign' | 'print'

export function ReceiveWizard({ parent, onClose }: Props) {
  const wiz = useReceiveWizard(parent)
  const parentDetails = useParentSampleDetails(parent.sample_id)
  const [phase, setPhase] = useState<Phase>('capture')
  const [editingSampleId, setEditingSampleId] = useState<string | null>(null)

  if (phase === 'assign') {
    return (
      <div className="grid grid-rows-[1fr_auto] h-full min-h-[500px]">
        <div className="overflow-y-auto">
          <AssignStep parentSampleId={parent.sample_id} />
        </div>
        <footer className="flex justify-between gap-2 px-6 py-3 border-t bg-muted/20 transition-colors">
          <Button type="button" variant="outline" onClick={() => setPhase('capture')}>
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Back
          </Button>
          <Button type="button" onClick={() => setPhase('print')}>
            <Printer className="w-4 h-4" aria-hidden="true" />
            Print labels
          </Button>
        </footer>
      </div>
    )
  }

  if (phase === 'print') {
    const printList = wiz.parentReceivedThisSession
      ? [{ sample_id: parent.sample_id }, ...wiz.sessionVials]
      : wiz.sessionVials
    return (
      <PrintStep
        parentSampleId={parent.sample_id}
        vials={printList}
        orderNumber={parentDetails.details?.client_order_number ?? null}
        onDone={onClose}
      />
    )
  }

  const editingSub = editingSampleId
    ? (wiz.vials.find(v => v.sub.sample_id === editingSampleId)?.sub ?? null)
    : null

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
          onSaveNew={async (photoBytes, remarks) => {
            const sub = await wiz.saveNewVial(photoBytes, remarks)
            setEditingSampleId(null)
            return sub
          }}
          onSaveEdit={async (sid, photoBytes, remarks) => {
            await wiz.editSessionVial(sid, photoBytes, remarks)
            setEditingSampleId(null)
          }}
          onDelete={async sid => {
            await wiz.deleteSessionVial(sid)
            setEditingSampleId(null)
          }}
        />
      </div>
      <footer className="flex justify-end gap-2 px-6 py-3 border-t bg-muted/20 transition-colors">
        <Button
          type="button"
          variant="outline"
          onClick={() => setPhase('assign')}
          disabled={!hasSessionVials}
          title={hasSessionVials ? undefined : 'Save at least one vial first'}
          className="disabled:opacity-50"
        >
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
          Continue
        </Button>
        <Button type="button" onClick={onClose}>
          <Check className="w-4 h-4" aria-hidden="true" />
          Finished
        </Button>
      </footer>
    </div>
  )
}
