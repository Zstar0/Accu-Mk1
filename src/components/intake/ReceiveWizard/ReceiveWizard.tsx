import { useState } from 'react'
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
    return <PrintStep vials={wiz.sessionVials} onDone={onClose} />
  }

  const editingSub = editingSampleId
    ? (wiz.vials.find(v => v.sub.sample_id === editingSampleId)?.sub ?? null)
    : null

  return (
    <div className="grid grid-cols-[260px_1fr] h-full min-h-[500px]">
      <WizardSidebar
        vials={wiz.vials}
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
          await wiz.saveNewVial(photoBytes, remarks)
          setEditingSampleId(null)
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
        onDone={() => setPhase('print')}
      />
    </div>
  )
}
