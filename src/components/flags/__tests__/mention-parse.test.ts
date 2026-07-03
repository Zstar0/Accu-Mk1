import { describe, expect, it } from 'vitest'
import {
  activeMentionQuery,
  mentionIdsInBody,
  renderCommentSegments,
} from '@/components/flags/mention-parse'

describe('activeMentionQuery', () => {
  it('opens a token at the caret after @', () => {
    expect(activeMentionQuery('hi @al', 6)).toEqual({ query: 'al', start: 3 })
  })
  it('is null with no @ before the caret', () => {
    expect(activeMentionQuery('hello', 5)).toBeNull()
  })
  it('closes on whitespace', () => {
    expect(activeMentionQuery('hi @al bob', 10)).toBeNull()
  })
})

describe('mentionIdsInBody', () => {
  const sel = new Map([
    [2, 'Alice Ng'],
    [3, 'Bob Ray'],
  ])
  it('keeps ids whose @name is still present', () => {
    expect(mentionIdsInBody('hey @Alice Ng!', sel)).toEqual([2])
  })
  it('drops ids whose text was removed', () => {
    expect(mentionIdsInBody('nobody here', sel)).toEqual([])
  })
})

describe('renderCommentSegments', () => {
  it('splits a body into text + mention segments', () => {
    const segs = renderCommentSegments('hey @Alice Ng ok', [2], id =>
      id === 2 ? 'Alice Ng' : `User ${id}`
    )
    expect(segs).toEqual([
      { text: 'hey ', mentionId: null },
      { text: '@Alice Ng', mentionId: 2 },
      { text: ' ok', mentionId: null },
    ])
  })
})
