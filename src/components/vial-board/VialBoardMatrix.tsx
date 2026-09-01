import type { BoardVial } from '@/lib/api'

/**
 * Matrix view — PLACEHOLDER (Task 6). Task 8 replaces this body with the
 * real parent x role-code grid; the prop contract below is load-bearing for
 * that task and for VialStatusPage's callsite, so keep it stable.
 */
export interface VialBoardMatrixProps {
  vials: BoardVial[]
  roleCodes: string[]
  roleLabel: (code: string) => string
}

export function VialBoardMatrix({ vials }: VialBoardMatrixProps) {
  return <div>Matrix — {vials.length} vials</div>
}
