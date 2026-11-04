/**
 * What the user is looking at, in the shape `POST /ai-chat/chats/{id}/prompt`
 * takes (`context.clean_context` validates it; a bad section drops all of it).
 */

import type { PageContext } from '@/lib/ai-chat-api'
import type { useUIStore } from '@/store/ui-store'

type UIState = ReturnType<typeof useUIStore.getState>

/**
 * The slice of the UI store this reads. `ui-store.ts` does not export its
 * `UIState`, so this is derived from the store itself: pass
 * `useUIStore.getState()`, or a plain object in a test.
 */
export type PageContextSource = Pick<
  UIState,
  | 'activeSection'
  | 'activeSubSection'
  | 'sampleDetailsTargetId'
  | 'orderExplorerTargetOrderId'
  | 'customerDetailTargetId'
  | 'documentViewerTargetId'
  | 'worksheetPageId'
>

/** `{section, subsection}` plus the first target that is set, in this order. */
export function currentPageContext(ui: PageContextSource): PageContext {
  const section = ui.activeSection
  const subsection = ui.activeSubSection
  const targets = [
    ['sample', ui.sampleDetailsTargetId],
    ['order', ui.orderExplorerTargetOrderId],
    ['customer', ui.customerDetailTargetId],
    ['document', ui.documentViewerTargetId],
    ['worksheet', ui.worksheetPageId],
  ] as const
  for (const [kind, id] of targets) {
    // `!== null`, not truthiness: 0 is an id. The backend only accepts a
    // string `target_id`, so the numeric ids are converted here.
    if (id !== null) {
      return { section, subsection, target_kind: kind, target_id: String(id) }
    }
  }
  return { section, subsection }
}
