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
import { VialDetailsTab, useCloseAndNavigate } from './VialDetailsTab'

type Phase = 'capture' | 'assign' | 'details' | 'print'

interface Props {
  parent: ParentInfo
  onClose: () => void
  // Which tab to open on. Defaults to 'capture' (intake / check-in flow).
  // SampleDetails entry passes 'details' so techs land on the sub-sample
  // table they came in to see, not the empty new-vial form.
  initialPhase?: Phase
}

export function ReceiveWizard({ parent, onClose, initialPhase = 'capture' }: Props) {
  const wiz = useReceiveWizard(parent)
  const parentDetails = useParentSampleDetails(parent.sample_id)
  const [phase, setPhase] = useState<Phase>(initialPhase)
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

  const closeAndNavigate = useCloseAndNavigate(onClose)

  // Print is a terminal step with its own self-contained layout (no shared
  // header/tabs/sidebar). Render it standalone.
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

  const phaseTabs = (
    <div className="px-6 py-2 border-b bg-muted/10">
      <Tabs value={phase} onValueChange={(v) => setPhase(v as Phase)}>
        <TabsList>
          <TabsTrigger value="capture">Vial Management</TabsTrigger>
          <TabsTrigger value="assign" disabled={!assignmentEnabled}>Assignment</TabsTrigger>
          <TabsTrigger value="details" disabled={wiz.vials.length === 0}>Sub Sample Details</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  )

  const sidebar = (
    <WizardSidebar
      parentDetails={parentDetails.details}
      parentDetailsLoading={parentDetails.loading}
      parentDetailsError={parentDetails.error}
    />
  )

  // Per-phase body content (right of the persistent sidebar).
  let body: React.ReactNode = null
  if (phase === 'capture') {
    body = (
      <div className="grid grid-cols-[1fr_240px] min-h-0 overflow-hidden">
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
                  assignmentRole: wiz.parentRole,
                }
              : null
          }
          activeSampleId={editingSampleId}
          onSelect={setEditingSampleId}
        />
      </div>
    )
  } else if (phase === 'assign') {
    body = (
      <div className="overflow-y-auto">
        <AssignStep parentSampleId={parent.sample_id} />
      </div>
    )
  } else if (phase === 'details') {
    body = (
      <VialDetailsTab
        vials={wiz.vials}
        orderNumber={parentDetails.details?.client_order_number ?? null}
        onCloseAndNavigate={closeAndNavigate}
      />
    )
  }

  // Per-phase footer (only assign + capture have one; details is terminal-ish).
  let footer: React.ReactNode = null
  if (phase === 'capture') {
    footer = (
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
    )
  } else if (phase === 'assign') {
    footer = (
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
    )
  }

  return (
    <div className="grid grid-rows-[auto_auto_1fr_auto] h-full min-h-[500px]">
      <WizardHeader
        parentSampleId={parent.sample_id}
        receivedCount={receivedCount}
      />
      {phaseTabs}
      <div className="grid grid-cols-[260px_1fr] min-h-0 overflow-hidden">
        {sidebar}
        {body}
      </div>
      {footer}
    </div>
  )
}
