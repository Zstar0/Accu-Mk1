import { lookupSenaiteSample } from '@/lib/api'
import type { ReadSource } from '@/lib/read-source'

// --- Senaite sequential fetch queue ---
// Single global queue serializes lookups so only one hits Senaite at a time
// (single-threaded Zope). Shared by OrderStatusPage and CustomerStatusPage —
// keeping this module-singleton prevents two parallel queues from racing Zope.
let _senaiteQueue: Promise<void> = Promise.resolve()

/** `source` resolves the 'sample_details' two-tier read-source setting
 *  (defaults to 'senaite' — matches lookupSenaiteSample's own default, so
 *  omitting it is behavior-identical to before this param existed). Only
 *  'senaite' actually hits SENAITE and needs the serialized queue.
 *
 *  'mk1' reads BYPASS the queue (v1.11.5): the registry route is a ~70ms
 *  threadpooled Mk1 read with no Zope to protect, and riding the serial
 *  queue made a 372-sample Order Status board take ~60s to populate.
 *  Parallel mk1 lookups are still bounded — lookupSenaiteSample runs them
 *  through their own concurrency limiter (registryLimiter in api.ts). */
export function enqueueSenaiteLookup(
  id: string,
  source: ReadSource = 'senaite'
) {
  if (source === 'mk1') {
    return lookupSenaiteSample(id, false, source)
  }
  // Callers opt into the 15-min cache (noCache=false) to avoid hammering Zope.
  const task = _senaiteQueue.then(() => lookupSenaiteSample(id, false, source))
  _senaiteQueue = task.then(
    Function.prototype as () => void,
    Function.prototype as () => void
  )
  return task
}
