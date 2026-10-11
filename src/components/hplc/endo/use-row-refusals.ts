import { useRef, useState } from 'react'
import type { WorksheetItemPatch } from '@/lib/api'
import type { EndoBoxProps } from './EndoBox'

/**
 * Boxes 2 and 3: each row's save goes through `send`, and a refusal (the
 * server's, from onUpdateItem's resolved message, or the box's own through
 * `refuse`) is kept per item id until that row's next save. Only a row's
 * latest save may set its refusal, so an earlier refusal landing after a
 * later save is dropped.
 */
export function useRowRefusals(onUpdateItem: EndoBoxProps['onUpdateItem']) {
  const [refused, setRefused] = useState<Record<number, string>>({})
  const latestSend = useRef<Record<number, number>>({})

  function bump(id: number): number {
    const seq = (latestSend.current[id] ?? 0) + 1
    latestSend.current[id] = seq
    return seq
  }

  function send(id: number, data: WorksheetItemPatch) {
    const seq = bump(id)
    setRefused(({ [id]: _cleared, ...rest }) => rest)
    void Promise.resolve(onUpdateItem(id, data)).then(msg => {
      if (msg && latestSend.current[id] === seq)
        setRefused(r => ({ ...r, [id]: msg }))
    })
  }

  /** A save the box will not send; outranks any reply still in flight. */
  function refuse(id: number, msg: string) {
    bump(id)
    setRefused(r => ({ ...r, [id]: msg }))
  }

  /** Rows written elsewhere (Box 3's reader import): their refusals are
   *  stale, and a reply still in flight for them is dropped. */
  function clear(ids: readonly number[]) {
    for (const id of ids) bump(id)
    setRefused(r =>
      Object.fromEntries(
        Object.entries(r).filter(([id]) => !ids.includes(Number(id)))
      )
    )
  }

  return { refused, send, refuse, clear }
}
