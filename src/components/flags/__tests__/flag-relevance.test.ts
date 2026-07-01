import { describe, expect, it } from 'vitest'
import { evaluateRelevance } from '@/components/flags/flag-relevance'

const base = { actorId: 9, assigneeId: null, createdBy: 9, mentions: [] }

describe('evaluateRelevance', () => {
  it('relevant to the assignee', () => {
    expect(evaluateRelevance({ ...base, assigneeId: 5 }, 5).relevant).toBe(true)
  })
  it('relevant to the creator', () => {
    expect(evaluateRelevance({ ...base, createdBy: 5 }, 5).relevant).toBe(true)
  })
  it('relevant + mentioned when mentioned', () => {
    const r = evaluateRelevance({ ...base, mentions: [5] }, 5)
    expect(r.relevant).toBe(true)
    expect(r.mentioned).toBe(true)
  })
  it('never notifies the actor about their own action', () => {
    expect(
      evaluateRelevance({ ...base, actorId: 5, mentions: [5] }, 5).relevant
    ).toBe(false)
  })
  it('not relevant to an unrelated user', () => {
    expect(evaluateRelevance(base, 5).relevant).toBe(false)
  })
})
