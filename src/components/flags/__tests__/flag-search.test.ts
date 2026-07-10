import { describe, expect, it } from 'vitest'
import { mergeSearchHits } from '@/components/flags/flag-search'
import type { FlagResponse, FlagSearchHit } from '@/lib/flags-api'

const mk = (id: number): FlagResponse =>
  ({
    id,
    entity_type: 'sample',
    entity_id: `P-${id}`,
    kind: 'issue',
    type: 'blocker',
    status: 'open',
    title: `t${id}`,
    created_by: 1,
    assignee_id: null,
    created_at: '',
    updated_at: '',
    resolved_at: null,
    resolved_by: null,
    due_at: null,
    entity: null,
  }) as FlagResponse

// Fills the decorative title/status/type fields (not exercised here) so each
// case states only the flag_id/snippet/matched_in it cares about.
const hit = (
  h: Partial<FlagSearchHit> & { flag_id: number }
): FlagSearchHit => ({
  snippet: '',
  matched_in: [],
  title: '',
  status: '',
  type: '',
  ...h,
})

describe('mergeSearchHits', () => {
  const tab = [mk(1), mk(2), mk(3)]

  it('appends comment-hit flags the client filter dropped, in tab order', () => {
    const clientVisible = [mk(1)] // e.g. flag 1 matched by title client-side
    const hits: FlagSearchHit[] = [
      hit({ flag_id: 3, snippet: '…residue…', matched_in: ['comment'] }),
    ]
    const { flags, searchMeta } = mergeSearchHits(tab, clientVisible, hits)
    expect(flags.map(f => f.id)).toEqual([1, 3])
    expect(searchMeta.get(3)?.snippet).toBe('…residue…')
    expect(searchMeta.has(1)).toBe(false)
  })

  it('does not duplicate a flag matched both client-side and in a comment', () => {
    const clientVisible = [mk(2)]
    const hits: FlagSearchHit[] = [
      hit({ flag_id: 2, snippet: '…foo…', matched_in: ['comment'] }),
    ]
    const { flags, searchMeta } = mergeSearchHits(tab, clientVisible, hits)
    expect(flags.map(f => f.id)).toEqual([2])
    expect(searchMeta.get(2)?.snippet).toBe('…foo…') // still annotated
  })

  it('ignores title-only hits (the client already matches titles)', () => {
    const hits: FlagSearchHit[] = [
      hit({ flag_id: 3, snippet: '', matched_in: ['title'] }),
    ]
    expect(mergeSearchHits(tab, [], hits).flags).toEqual([])
  })

  it('ignores hits for flags outside the current tab', () => {
    const hits: FlagSearchHit[] = [
      hit({ flag_id: 99, snippet: '…x…', matched_in: ['comment'] }),
    ]
    expect(mergeSearchHits(tab, [], hits).flags).toEqual([])
  })
})
