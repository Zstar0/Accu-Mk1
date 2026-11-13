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

/**
 * `{section, subsection}` plus the target of the page the user is on, if it
 * has one. Most target ids in the UI store are sticky (`sampleDetailsTargetId`
 * outlives the sample page), so each is read only on its own subsection, the
 * same pairing `buildHash` in `src/lib/hash-navigation.ts` uses; a stale id
 * would otherwise label Reports as "sample P-1234".
 */
export function currentPageContext(ui: PageContextSource): PageContext {
  const section = ui.activeSection
  const subsection = ui.activeSubSection
  const targets = [
    ['sample', 'sample-details', ui.sampleDetailsTargetId],
    ['order', 'order-explorer', ui.orderExplorerTargetOrderId],
    ['customer', 'customer-detail', ui.customerDetailTargetId],
    ['document', 'documents', ui.documentViewerTargetId],
    ['worksheet', 'worksheet', ui.worksheetPageId],
  ] as const
  for (const [kind, page, id] of targets) {
    // `!= null`, not truthiness: 0 is an id; it also skips an undefined one,
    // as `buildHash` does. The backend only accepts a string `target_id`, so
    // the numeric ids are converted here.
    if (subsection === page && id != null) {
      return { section, subsection, target_kind: kind, target_id: String(id) }
    }
  }
  return { section, subsection }
}
