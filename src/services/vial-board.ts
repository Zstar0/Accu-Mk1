import { useQuery } from '@tanstack/react-query'
import { getVialBoard, type VialBoardResponse } from '@/lib/api'

export const vialBoardQueryKeys = {
  board: (hideTestOrders: boolean, showXtra: boolean) =>
    ['vial-board', { hideTestOrders, showXtra }] as const,
}

export function useVialBoard(params: {
  hideTestOrders: boolean
  showXtra: boolean
}) {
  return useQuery({
    queryKey: vialBoardQueryKeys.board(params.hideTestOrders, params.showXtra),
    queryFn: () => getVialBoard(params),
    refetchInterval: 30_000, // 30s polling — inbox parity (spec §5)
    staleTime: 0, // live queue, always fresh
  })
}

export type { VialBoardResponse }
