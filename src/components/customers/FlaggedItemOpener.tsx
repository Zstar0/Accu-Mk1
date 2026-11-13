import { useEffect, useState } from 'react'
import type { CrmItem, CrmItemType } from '@/lib/api-crm'
import type { SupportThread } from '@/lib/api-support'
import { useUIStore, type PendingCustomerItem } from '@/store/ui-store'
import { CrmActivityPanel } from './CrmActivityPanel'
import { SupportThreadPanel } from './SupportThreadPanel'

type Opened =
  | { kind: 'support'; thread: SupportThread }
  | { kind: 'crm'; item: CrmItem }

/** A minimal row for the slide-out; its detail query fills in the rest. */
function toOpened(
  pending: PendingCustomerItem | null,
  customerKey: string
): Opened | null {
  if (!pending) return null
  const [key, a, b] = pending.entityId.split('|')
  if (key !== customerKey || !a) return null
  if (pending.kind === 'support') {
    return {
      kind: 'support',
      thread: {
        id: a,
        ref: '',
        title: '',
        status: 'open',
        priority: 'normal',
        labels: [],
        assignee: null,
        created_at: null,
        updated_at: null,
        preview: '',
        waiting_since: null,
        plain_url: '',
      },
    }
  }
  if (!b) return null
  return {
    kind: 'crm',
    item: {
      id: b,
      type: a as CrmItemType,
      at: null,
      direction: null,
      who: '',
      title: '',
      preview: '',
      lead_id: null,
      lead_name: '',
      automated: false,
      support_thread_url: null,
    },
  }
}

function Opener({ customerKey }: { customerKey: string }) {
  const [opened, setOpened] = useState<Opened | null>(() =>
    toOpened(useUIStore.getState().pendingCustomerItem, customerKey)
  )
  useEffect(() => {
    if (opened) useUIStore.getState().consumePendingCustomerItem()
  }, [opened])
  if (!opened) return null
  return opened.kind === 'support' ? (
    <SupportThreadPanel
      customerKey={customerKey}
      thread={opened.thread}
      onClose={() => setOpened(null)}
    />
  ) : (
    <CrmActivityPanel
      customerKey={customerKey}
      item={opened.item}
      onClose={() => setOpened(null)}
    />
  )
}

/**
 * Opens the ticket or CRM item a flag link points at (deep link kind
 * `customer_item`), whether or not the viewer can see its tab. Remounts per
 * navigation so a link followed while already on this customer still opens.
 */
export function FlaggedItemOpener({ customerKey }: { customerKey: string }) {
  const navigationKey = useUIStore(s => s.navigationKey)
  return <Opener key={navigationKey} customerKey={customerKey} />
}
