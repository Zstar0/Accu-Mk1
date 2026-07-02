import { describe, it, expect } from 'vitest'
import {
  parseFrames,
  filterNewEvents,
  type FlagStreamEvent,
} from '@/lib/flag-stream'

/** Build a wire frame exactly as the backend emits it (id + event + data). */
function frame(eventId: number, eventType: string, overrides = {}): string {
  const data: FlagStreamEvent = {
    event_type: eventType,
    flag_id: eventId,
    actor_id: 1,
    from_value: null,
    to_value: null,
    details: null,
    event_id: eventId,
    flag: {
      id: eventId,
      title: `Flag ${eventId}`,
      type: 'blocker',
      kind: 'issue',
      status: 'open',
      entity_type: 'sub_sample',
      entity_id: '1',
      assignee_id: null,
      created_by: 1,
    },
    ...overrides,
  }
  return `id: ${eventId}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
}

describe('parseFrames', () => {
  it('parses two complete frames and returns the partial as rest', () => {
    const partial = 'id: 3\nevent: comm' // no terminating blank line yet
    const buffer = frame(1, 'raised') + frame(2, 'assigned') + partial

    const { events, rest } = parseFrames(buffer)

    expect(events).toHaveLength(2)
    expect(events[0]?.event_type).toBe('raised')
    expect(events[0]?.event_id).toBe(1)
    expect(events[1]?.event_type).toBe('assigned')
    expect(events[1]?.flag.id).toBe(2)
    expect(rest).toBe(partial)
  })

  it('completes a frame once the partial is fed its blank-line terminator', () => {
    const first = parseFrames(frame(1, 'raised') + 'id: 2\nevent: rai')
    expect(first.events).toHaveLength(1)

    // Next chunk completes frame 2.
    const continued =
      first.rest + frame(2, 'raised').slice('id: 2\nevent: rai'.length)
    const second = parseFrames(continued)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]?.event_id).toBe(2)
  })

  it('ignores heartbeat/comment frames (": keepalive")', () => {
    const buffer = ': connected\n\n' + frame(1, 'raised') + ': keepalive\n\n'
    const { events, rest } = parseFrames(buffer)
    expect(events).toHaveLength(1)
    expect(events[0]?.event_id).toBe(1)
    expect(rest).toBe('')
  })

  it('skips malformed JSON without throwing', () => {
    const buffer = 'event: raised\ndata: {not json}\n\n' + frame(5, 'raised')
    const { events } = parseFrames(buffer)
    expect(events).toHaveLength(1)
    expect(events[0]?.event_id).toBe(5)
  })
})

describe('filterNewEvents', () => {
  it('de-dupes by event_id across calls (server replay)', () => {
    const seen = new Set<number>()
    const batch1 = parseFrames(frame(1, 'raised') + frame(2, 'assigned')).events
    const fresh1 = filterNewEvents(batch1, seen)
    expect(fresh1.map(e => e.event_id)).toEqual([1, 2])

    // Replay frame 2 alongside a new frame 3 — only 3 is logically new.
    const batch2 = parseFrames(
      frame(2, 'assigned') + frame(3, 'commented')
    ).events
    const fresh2 = filterNewEvents(batch2, seen)
    expect(fresh2.map(e => e.event_id)).toEqual([3])
  })
})
