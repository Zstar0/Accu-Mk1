import type { SubSample } from '@/lib/api'

interface VialPanelProps {
  parentSampleId: string
  editingSub: SubSample | null
  loading: boolean
  error: string | null
  onSaveNew: (photoBytes: Uint8Array, remarks?: string) => Promise<void>
  onSaveEdit: (
    sampleId: string,
    photoBytes?: Uint8Array,
    remarks?: string,
  ) => Promise<void>
  onDelete: (sampleId: string) => Promise<void>
  onDone: () => void
}

export function VialPanel(_props: VialPanelProps) {
  return null
}
