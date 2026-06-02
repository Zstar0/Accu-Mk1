import { useState } from 'react'
import { Printer, ArrowRight, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useReceiveWizard, type ParentInfo } from './useReceiveWizard'
import { useParentSampleDetails } from './useParentSampleDetails'
import { WizardHeader } from './WizardHeader'
import { WizardSidebar } from './WizardSidebar'
import { VialsList } from './VialsList'
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

  // Received count = parent (if received) + sub-samples in the list.
  // The receive count is identical across all phases since it tracks the
  // parent's vial set, not phase-local state.
  const receivedCount =
    (wiz.parentReceived ? 1 : 0) + wiz.vials.length

  // Assignment tab is meaningful when the parent already exists (typical for
  // sample detail entry) OR when at least one vial has been saved this session
  // (check-in flow). Disable otherwise.
  const assignmentEnabled = wiz.parentReceived || wiz.vials.length > 0

  const phaseTabs = (
    <div className="px-6 py-2 border-b bg-muted/10">
      <Tabs value={phase} onValueChange={(v) => setPhase(v as Phase)}>
        <TabsList>
          <TabsTrigger value="capture">Vial Management</TabsTrigger>
          <TabsTrigger value="assign" disabled={!assignmentEnabled}>Assignment</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  )

  if (phase === 'assign') {
    return (
      <div className="grid grid-rows-[auto_auto_1fr_auto] h-full min-h-[500px]">
        <WizardHeader
          parentSampleId={parent.sample_id}
          receivedCount={receivedCount}
        />
        {phaseTabs}
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
        onBack={() => setPhase('assign')}
      />
    )
  }

  const editingSub = editingSampleId
    ? (wiz.vials.find(v => v.sub.sample_id === editingSampleId)?.sub ?? null)
    : null

  const hasSessionVials = wiz.sessionVials.length > 0 || wiz.parentReceivedThisSession

  return (
    <div className="grid grid-rows-[auto_auto_1fr_auto] h-full min-h-[500px]">
      <WizardHeader
        parentSampleId={parent.sample_id}
        receivedCount={receivedCount}
      />
      {phaseTabs}
      <div className="grid grid-cols-[260px_1fr_240px] min-h-0 overflow-hidden">
        <WizardSidebar
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
        <VialsList
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
        />
      </div>
      <footer className="flex justify-end gap-2 px-6 py-3 border-t bg-muted/20 transition-colors">
        <Button
          type="button"
          onClick={() => setPhase('assign')}
          disabled={!hasSessionVials}
          title={hasSessionVials ? undefined : 'Save at least one vial first'}
          className="disabled:opacity-50"
        >
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
          Continue
        </Button>
      </footer>
    </div>
  )
}
