import { useEffect, useState } from 'react'
import { ArrowRight, ArrowLeft, Check } from 'lucide-react'
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
import { PackagingPanel } from './PackagingPanel'
import { PackagingImagesList } from './PackagingImagesList'
import type { PackagingPhoto } from '@/lib/api'

type Phase = 'packaging' | 'capture' | 'assign' | 'print' | 'details'

interface Props {
  parent: ParentInfo
  onClose: () => void
  // Which tab to open on. Defaults to 'capture' (intake / check-in flow).
  // SampleDetails entry passes 'details' so techs land on the sub-sample
  // table they came in to see, not the empty new-vial form.
  initialPhase?: Phase
  // Drops the persistent SampleInfoPanel sidebar so the body reflows to full
  // width. Used by the order-session flow, which surfaces the same sample
  // context in its own header — keeping the panel here would duplicate it.
  // Default false: the standalone single-sample path is untouched.
  hideSampleInfo?: boolean
}

export function ReceiveWizard({
  parent,
  onClose,
  initialPhase = 'capture',
  hideSampleInfo = false,
}: Props) {
  const wiz = useReceiveWizard(parent)
  const parentDetails = useParentSampleDetails(parent.sample_id)
  const [phase, setPhase] = useState<Phase>(initialPhase)
  const [editingSampleId, setEditingSampleId] = useState<string | null>(null)
  const [editingPackaging, setEditingPackaging] = useState<PackagingPhoto | null>(null)

  // Sub Sample Details table reads assignment_role off the wizard's local
  // vials state. AssignStep mutates roles via its own PATCH calls and never
  // tells us, so without this re-fetch the Role column shows stale values
  // (typically "Unassigned") after a tech assigns and switches tabs.
  useEffect(() => {
    if (phase === 'details') void wiz.refresh()
  }, [phase, wiz.refresh])

  // Received count: legacy families count the parent as a received vial
  // (parent IS vial 1); container families count only physical sub-samples.
  // Identical across all phases since it tracks the parent's vial set.
  const receivedCount =
    (wiz.containerMode ? 0 : (wiz.parentReceived ? 1 : 0)) + wiz.vials.length

  // Assignment tab is meaningful when the parent already exists (typical for
  // sample detail entry) OR when at least one vial has been saved this session
  // (check-in flow). Disable otherwise.
  const assignmentEnabled = wiz.parentReceived || wiz.vials.length > 0

  const closeAndNavigate = useCloseAndNavigate(onClose)

  const editingSub = editingSampleId
    ? (wiz.vials.find(v => v.sub.sample_id === editingSampleId)?.sub ?? null)
    : null
  // Delete is only offered for vials created in THIS session — editing a
  // prior-session vial's photo/remarks is safe, but deleting an established
  // vial from a completed check-in is not something we expose by accident.
  const editingIsThisSession = editingSampleId
    ? (wiz.vials.find(v => v.sub.sample_id === editingSampleId)?.isThisSession ?? false)
    : false

  const hasSessionVials = wiz.sessionVials.length > 0 || wiz.parentReceivedThisSession

  // Print Labels tab shows ALL labels for the family whenever the parent has
  // been received — so a tech entering from sample details can reprint any
  // existing label, not just session ones. The checkbox row on the print
  // tab lets them skip labels they don't actually want. Each entry carries
  // received_at so the label can render the check-in date.
  const printList: { sample_id: string; received_at?: string | null }[] = wiz.parentReceived
    ? [
        {
          sample_id: parent.sample_id,
          received_at: parentDetails.details?.date_received ?? null,
        },
        ...wiz.vials.map(v => ({
          sample_id: v.sub.sample_id,
          received_at: v.sub.received_at,
        })),
      ]
    : wiz.sessionVials.map(s => ({ sample_id: s.sample_id, received_at: s.received_at }))

  // Finish is the intake-flow's "I'm done capturing" verb. When the wizard is
  // opened from sample details (initialPhase='details') against an already-
  // received sample, Finish doesn't read right — there's nothing to finish.
  // Show it again the moment session activity starts (new vial saved this
  // session) since the tech is now actively doing intake work.
  const showFinish = hasSessionVials || initialPhase !== 'details'

  const phaseTabs = (
    <div className="px-6 py-2 border-b bg-muted/10">
      {/* activationMode="manual": the Radix Dialog autofocuses the first
          focusable element on open — the first tab trigger — and automatic
          activation would select it on focus, stomping initialPhase (the
          sample-details entry opens on "details"). Manual = switch on
          click/Enter only. */}
      <Tabs
        value={phase}
        onValueChange={(v) => setPhase(v as Phase)}
        activationMode="manual"
      >
        <TabsList>
          <TabsTrigger value="packaging">Packaging</TabsTrigger>
          <TabsTrigger value="capture">Vial Management</TabsTrigger>
          <TabsTrigger value="assign" disabled={!assignmentEnabled}>Assignment</TabsTrigger>
          <TabsTrigger value="print" disabled={printList.length === 0}>Print Labels</TabsTrigger>
          <TabsTrigger value="details" disabled={wiz.vials.length === 0}>Sub Sample Details</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  )

  const finishButton = (
    <Button type="button" variant="outline" onClick={onClose} className="gap-2">
      <Check className="w-4 h-4" aria-hidden="true" />
      Finish
    </Button>
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
  if (phase === 'packaging') {
    body = (
      <div className="grid grid-cols-[1fr_240px] min-h-0 overflow-hidden">
        <PackagingPanel parentSampleId={parent.sample_id} editing={editingPackaging}
          onSaved={() => setEditingPackaging(null)} onCancelEdit={() => setEditingPackaging(null)} />
        <PackagingImagesList parentSampleId={parent.sample_id} onEdit={setEditingPackaging} />
      </div>
    )
  } else if (phase === 'capture') {
    body = (
      <div className="grid grid-cols-[1fr_240px] min-h-0 overflow-hidden">
        <VialPanel
          parentSampleId={parent.sample_id}
          parentDetails={parentDetails.details}
          editingSub={editingSub}
          canDelete={editingIsThisSession}
          loading={wiz.loading}
          error={wiz.error}
          onSaveNew={async (photoBytes, remarks) => {
            const sub = await wiz.saveNewVial(photoBytes, remarks)
            setEditingSampleId(null)
            return sub
          }}
          onSaveNewBulk={async (photoBytes, remarks, count) => {
            const r = await wiz.saveNewVialsBulk(photoBytes, remarks, count)
            setEditingSampleId(null)
            return r
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
            // Container families never render the parent as Vial 1.
            wiz.parentReceived && !wiz.containerMode
              ? {
                  sampleId: parent.sample_id,
                  receivedThisSession: wiz.parentReceivedThisSession,
                  assignmentRole: wiz.parentRole,
                }
              : null
          }
          activeSampleId={editingSampleId}
          onSelect={setEditingSampleId}
          containerMode={wiz.containerMode}
        />
      </div>
    )
  } else if (phase === 'assign') {
    body = (
      <div className="overflow-y-auto">
        <AssignStep
          parentSampleId={parent.sample_id}
          parentSampleUid={parent.uid}
        />
      </div>
    )
  } else if (phase === 'print') {
    body = (
      <PrintStep
        parentSampleId={parent.sample_id}
        vials={printList}
        orderNumber={parentDetails.details?.client_order_number ?? null}
        orderDate={parentDetails.details?.date_received ?? null}
      />
    )
  } else if (phase === 'details') {
    body = (
      <VialDetailsTab
        vials={wiz.vials}
        orderNumber={parentDetails.details?.client_order_number ?? null}
        onCloseAndNavigate={closeAndNavigate}
        containerMode={wiz.containerMode}
      />
    )
  }

  // Every footer carries Finish so a tech can close the wizard from any tab
  // during intake — capturing alone is a valid stopping point, you don't
  // have to walk through assign + print to be "done". When viewing from
  // sample details (showFinish=false), Finish drops out and the Dialog X
  // is the close affordance.
  let footer: React.ReactNode = null
  if (phase === 'capture') {
    footer = (
      <footer className="flex justify-end gap-2 px-6 py-3 border-t bg-muted/20 transition-colors">
        {showFinish && finishButton}
        <Button
          type="button"
          onClick={() => setPhase('assign')}
          disabled={!hasSessionVials}
          title={hasSessionVials ? undefined : 'Save at least one vial first'}
          className="disabled:opacity-50 gap-2"
        >
          Continue
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </Button>
      </footer>
    )
  } else if (phase === 'assign') {
    footer = (
      <footer className="flex justify-between gap-2 px-6 py-3 border-t bg-muted/20 transition-colors">
        <Button type="button" variant="outline" onClick={() => setPhase('capture')} className="gap-2">
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          Back
        </Button>
        <div className="flex gap-2">
          {showFinish && finishButton}
          <Button type="button" onClick={() => setPhase('print')} className="gap-2">
            Print Labels
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </Button>
        </div>
      </footer>
    )
  } else if (phase === 'print') {
    footer = (
      <footer className="flex justify-between gap-2 px-6 py-3 border-t bg-muted/20 transition-colors">
        <Button type="button" variant="outline" onClick={() => setPhase('assign')} className="gap-2">
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          Back
        </Button>
        {showFinish && finishButton}
      </footer>
    )
  } else if (phase === 'details' && showFinish) {
    footer = (
      <footer className="flex justify-end gap-2 px-6 py-3 border-t bg-muted/20 transition-colors">
        {finishButton}
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
      <div
        className={
          hideSampleInfo
            ? 'grid grid-cols-1 min-h-0 overflow-hidden'
            : 'grid grid-cols-[260px_1fr] min-h-0 overflow-hidden'
        }
      >
        {!hideSampleInfo && sidebar}
        {body}
      </div>
      {footer}
    </div>
  )
}
