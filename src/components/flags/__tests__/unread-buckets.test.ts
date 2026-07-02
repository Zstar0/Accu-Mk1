import { describe, expect, it } from 'vitest'
import { unreadBuckets } from '@/components/flags/unread-buckets'
import type { FlagResponse } from '@/lib/flags-api'

const f = (over: Partial<FlagResponse>): FlagResponse =>
  ({
    id: 1,
    entity_type: 'sub_sample',
    entity_id: '1',
    kind: 'issue',
    type: 'blocker',
    status: 'open',
    title: 't',
    created_by: 9,
    assignee_id: null,
    created_at: '',
    updated_at: '',
    resolved_at: null,
    resolved_by: null,
    ...over,
  }) as FlagResponse

describe('unreadBuckets', () => {
  it('assigned when an open flag is assigned to me', () => {
    expect(unreadBuckets([f({ assignee_id: 5 })], 5).assigned).toBe(true)
  })
  it('raised when I created it', () => {
    expect(unreadBuckets([f({ created_by: 5 })], 5).raised).toBe(true)
  })
  it('watching when relevant but neither mine-assigned nor mine-created', () => {
    const b = unreadBuckets([f({ assignee_id: 9, created_by: 9 })], 5)
    expect(b.watching).toBe(true)
  })
  it('assigned excludes closed flags', () => {
    expect(
      unreadBuckets([f({ assignee_id: 5, status: 'closed' })], 5).assigned
    ).toBe(false)
  })
})
