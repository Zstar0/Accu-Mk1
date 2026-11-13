import { Map as MapIcon } from 'lucide-react'
import type { AppCommand } from '@/lib/commands/types'
import type { BoardDetail } from '@/lib/api-boards'
import { useUIStore } from '@/store/ui-store'

/** Cmd+K entries for the open board's items (spec 8.3): selecting one centres the item. */
export function boardNodeCommands(board: BoardDetail): AppCommand[] {
  return board.nodes.map(n => ({
    id: `board:${board.slug}:node:${n.id}`,
    labelKey: 'commands.boardItem.label',
    label: n.context?.label ?? n.label,
    group: 'board',
    icon: MapIcon,
    keywords: [n.kind],
    execute: () => useUIStore.getState().setPendingBoardNode(String(n.id)),
    isAvailable: () => useUIStore.getState().boardTargetSlug === board.slug,
  }))
}
