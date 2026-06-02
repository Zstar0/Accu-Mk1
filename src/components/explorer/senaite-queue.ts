import { lookupSenaiteSample } from '@/lib/api'

// --- Senaite sequential fetch queue ---
// Single global queue serializes lookups so only one hits Senaite at a time
// (single-threaded Zope). Shared by OrderStatusPage and CustomerStatusPage —
// keeping this module-singleton prevents two parallel queues from racing Zope.
let _senaiteQueue: Promise<void> = Promise.resolve()

export function enqueueSenaiteLookup(id: string) {
  // Callers opt into the 15-min cache (noCache=false) to avoid hammering Zope.
  const task = _senaiteQueue.then(() => lookupSenaiteSample(id, false))
  _senaiteQueue = task.then(
    Function.prototype as () => void,
    Function.prototype as () => void
  )
  return task
}
