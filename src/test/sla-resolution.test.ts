import { describe, it, expect } from 'vitest'
import type {
  AnalysisServiceRecord,
  ServiceGroup,
  SlaTier,
  SenaiteAnalysis,
  SenaiteLookupResult,
  InboxPriority,
} from '@/lib/api'
import {
  buildKeywordToServiceIdMap,
  buildServiceToGroupTierMap,
  buildServiceIdToGroupIdMap,
  buildGroupIdToTierMap,
  buildGlobalPriorityToTierMap,
  buildPerGroupPriorityToTierMap,
  resolveSampleTier,
  resolveSampleTierWithReason,
  resolveSampleTiersByGroup,
  classifySampleColor,
  aggregateOrderSlaVerdict,
  NO_GROUP_KEY,
  type SampleSlaInputs,
} from '@/lib/sla-resolution'
import type { SlaPriorityTier } from '@/lib/api'

const tier = (
  id: number,
  name: string,
  target_minutes: number,
  amber = 20,
  is_default = false,
  business_hours_only = false
): SlaTier => ({
  id,
  name,
  target_minutes,
  business_hours_only,
  is_default,
  amber_threshold_percent: amber,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-01-01T00:00:00',
})

const group = (
  id: number,
  name: string,
  sla_tier_id: number | null,
  member_ids: number[]
): ServiceGroup => ({
  id,
  name,
  description: null,
  color: 'blue',
  sort_order: 0,
  is_default: false,
  sla_tier_id,
  member_count: member_ids.length,
  member_ids,
} as unknown as ServiceGroup)

const svc = (id: number, keyword: string | null): AnalysisServiceRecord => ({
  id,
  title: `Service ${id}`,
  keyword,
  category: null,
  unit: null,
  methods: null,
  peptide_name: null,
  peptide_id: null,
  senaite_id: null,
  senaite_uid: null,
  active: true,
} as unknown as AnalysisServiceRecord)

const analysis = (keyword: string | null): SenaiteAnalysis => ({
  uid: `uid-${keyword ?? 'none'}`,
  keyword,
  title: `T-${keyword ?? 'none'}`,
  result: null,
  result_options: [],
  unit: null,
  method: null,
  method_uid: null,
  method_options: [],
  instrument: null,
  instrument_uid: null,
  analyst: null,
  analyst_username: null,
  due_date: null,
  review_state: null,
  sort_key: null,
} as unknown as SenaiteAnalysis)

const lookup = (
  date_received: string | null,
  review_state: string | null,
  keywords: (string | null)[]
): SenaiteLookupResult => ({
  sample_id: 'PB-0001',
  sample_uid: 'uid-PB-0001',
  client_sample_id: null,
  client: null,
  sample_type: null,
  date_received,
  date_sampled: null,
  date_received_lab: null,
  date_received_lab_naive: null,
  client_lot: null,
  review_state,
  declared_weight_mg: null,
  declared_volume_ml: null,
  retest_of: null,
  remarks: [],
  analyses: keywords.map(analysis),
  attachments: [],
} as unknown as SenaiteLookupResult)

const DEFAULT_TIER = tier(1, 'Standard', 1440, 20, true)

describe('buildKeywordToServiceIdMap', () => {
  it('maps each service keyword to its id', () => {
    const map = buildKeywordToServiceIdMap([
      svc(100, 'HPLC-A'),
      svc(101, 'HPLC-B'),
    ])
    expect(map.get('HPLC-A')).toBe(100)
    expect(map.get('HPLC-B')).toBe(101)
  })

  it('skips services with null keyword', () => {
    const map = buildKeywordToServiceIdMap([svc(100, null), svc(101, 'HPLC')])
    expect(map.has('HPLC')).toBe(true)
    expect(map.size).toBe(1)
  })

  it('returns an empty map for empty input', () => {
    expect(buildKeywordToServiceIdMap([]).size).toBe(0)
  })
})

describe('buildServiceToGroupTierMap', () => {
  it('maps single-group analysis service to its group tier', () => {
    const tierA = tier(10, 'A', 480, 25)
    const tiersById = new Map<number, SlaTier>([[tierA.id, tierA]])
    const map = buildServiceToGroupTierMap(
      [group(1, 'G1', tierA.id, [100])],
      tiersById
    )
    expect(map.get(100)).toEqual(tierA)
  })

  it('multi-group: tightest target wins', () => {
    const tightTier = tier(10, 'Tight', 240, 20)
    const looseTier = tier(11, 'Loose', 2880, 20)
    const tiersById = new Map<number, SlaTier>([
      [tightTier.id, tightTier],
      [looseTier.id, looseTier],
    ])
    const map = buildServiceToGroupTierMap(
      [
        group(1, 'GLoose', looseTier.id, [100, 200]),
        group(2, 'GTight', tightTier.id, [200]),
      ],
      tiersById
    )
    expect(map.get(100)).toEqual(looseTier)
    expect(map.get(200)).toEqual(tightTier)
  })

  it('group without sla_tier_id contributes nothing', () => {
    const tiersById = new Map<number, SlaTier>()
    const map = buildServiceToGroupTierMap(
      [group(1, 'NoTier', null, [100])],
      tiersById
    )
    expect(map.has(100)).toBe(false)
  })

  it('group references a tier id missing from tiersById: silently skipped', () => {
    const tiersById = new Map<number, SlaTier>() // empty
    const map = buildServiceToGroupTierMap(
      [group(1, 'PhantomTierGroup', 999, [100])],
      tiersById
    )
    expect(map.has(100)).toBe(false)
  })

  it('multi-group tie on target_minutes: first-seen wins (locks current semantics)', () => {
    const tA = tier(10, 'A', 480, 20)
    const tB = tier(11, 'B', 480, 30) // same target_minutes, different amber
    const tiersById = new Map<number, SlaTier>([[tA.id, tA], [tB.id, tB]])
    const map = buildServiceToGroupTierMap(
      [
        group(1, 'GA', tA.id, [100]),
        group(2, 'GB', tB.id, [100]),
      ],
      tiersById
    )
    // First group iterated wins; strict `<` predicate means equal target_minutes does NOT replace.
    expect(map.get(100)).toEqual(tA)
  })
})

describe('resolveSampleTier', () => {
  const priorityOverrideTier = tier(20, 'Expedited', 60, 50)
  const groupTier = tier(21, 'Group', 480, 30)
  const priorityToTier = new Map<InboxPriority, SlaTier>([
    ['expedited', priorityOverrideTier],
  ])

  it('priority override beats group beats default', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis('HPLC-100')],
      priority: 'expedited',
    }
    const svcToGroupTier = new Map<number, SlaTier>([[100, groupTier]])
    const keywordToServiceId = new Map<string, number>([['HPLC-100', 100]])
    expect(
      resolveSampleTier(
        inputs,
        keywordToServiceId,
        svcToGroupTier,
        priorityToTier,
        DEFAULT_TIER
      )
    ).toEqual(priorityOverrideTier)
  })

  it('group tier when no priority override matches', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis('HPLC-100')],
      priority: 'normal',
    }
    const svcToGroupTier = new Map<number, SlaTier>([[100, groupTier]])
    const keywordToServiceId = new Map<string, number>([['HPLC-100', 100]])
    expect(
      resolveSampleTier(inputs, keywordToServiceId, svcToGroupTier, priorityToTier, DEFAULT_TIER)
    ).toEqual(groupTier)
  })

  it('multi-group: tightest tier across analyses wins', () => {
    const tightTier = tier(30, 'Tight', 120, 20)
    const inputs: SampleSlaInputs = {
      analyses: [analysis('LOOSE'), analysis('TIGHT')],
      priority: 'normal',
    }
    const svcToGroupTier = new Map<number, SlaTier>([
      [101, groupTier],   // 480 min
      [102, tightTier],   // 120 min
    ])
    const keywordToServiceId = new Map<string, number>([
      ['LOOSE', 101],
      ['TIGHT', 102],
    ])
    expect(
      resolveSampleTier(inputs, keywordToServiceId, svcToGroupTier, priorityToTier, DEFAULT_TIER)
    ).toEqual(tightTier)
  })

  it('test_unmapped_analysis_keyword_falls_through_to_default', () => {
    // Keyword on the sample has no row in the keyword→service map (e.g. brand
    // new analysis the lab has not yet wired into a service group).
    const inputs: SampleSlaInputs = {
      analyses: [analysis('NOT-IN-CATALOG')],
      priority: 'normal',
    }
    expect(
      resolveSampleTier(
        inputs,
        new Map(),
        new Map(),
        new Map(),
        DEFAULT_TIER
      )
    ).toEqual(DEFAULT_TIER)
  })

  it('null keyword analyses are skipped (no crash, falls through)', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis(null)],
      priority: 'normal',
    }
    expect(
      resolveSampleTier(inputs, new Map(), new Map(), new Map(), DEFAULT_TIER)
    ).toEqual(DEFAULT_TIER)
  })

  it('no analyses and no default returns null', () => {
    const inputs: SampleSlaInputs = { analyses: [], priority: 'normal' }
    expect(
      resolveSampleTier(inputs, new Map(), new Map(), new Map(), null)
    ).toBeNull()
  })
})

describe('resolveSampleTierWithReason', () => {
  const priorityOverrideTier = tier(20, 'Expedited', 60, 50)
  const groupTier = tier(21, 'Group', 480, 30)
  const priorityToTier = new Map<InboxPriority, SlaTier>([
    ['expedited', priorityOverrideTier],
  ])

  it('priority override → tierSource priority + priorityUsed', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis('HPLC-100')],
      priority: 'expedited',
    }
    const svcToGroupTier = new Map<number, SlaTier>([[100, groupTier]])
    const keywordToServiceId = new Map<string, number>([['HPLC-100', 100]])
    const { tier: out, reason } = resolveSampleTierWithReason(
      inputs,
      keywordToServiceId,
      svcToGroupTier,
      priorityToTier,
      DEFAULT_TIER
    )
    expect(out).toEqual(priorityOverrideTier)
    expect(reason.tierSource).toBe('priority')
    expect(reason.priorityUsed).toBe('expedited')
    // Priority short-circuits before keyword inspection — unmappedKeywords
    // should be empty regardless of what the analyses contain.
    expect(reason.unmappedKeywords).toEqual([])
    expect(reason.multiGroupCandidates).toBeUndefined()
  })

  it('single group tier → tierSource group, multiGroupCandidates undefined', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis('HPLC-100')],
      priority: 'normal',
    }
    const svcToGroupTier = new Map<number, SlaTier>([[100, groupTier]])
    const keywordToServiceId = new Map<string, number>([['HPLC-100', 100]])
    const { tier: out, reason } = resolveSampleTierWithReason(
      inputs,
      keywordToServiceId,
      svcToGroupTier,
      priorityToTier,
      DEFAULT_TIER
    )
    expect(out).toEqual(groupTier)
    expect(reason.tierSource).toBe('group')
    expect(reason.multiGroupCandidates).toBeUndefined()
    expect(reason.unmappedKeywords).toEqual([])
  })

  it('multi-group → tierSource group with multiGroupCandidates listing all candidates', () => {
    const tightTier = tier(30, 'Tight', 120, 20)
    const inputs: SampleSlaInputs = {
      analyses: [analysis('LOOSE'), analysis('TIGHT')],
      priority: 'normal',
    }
    const svcToGroupTier = new Map<number, SlaTier>([
      [101, groupTier], // 480 min
      [102, tightTier], // 120 min
    ])
    const keywordToServiceId = new Map<string, number>([
      ['LOOSE', 101],
      ['TIGHT', 102],
    ])
    const { tier: out, reason } = resolveSampleTierWithReason(
      inputs,
      keywordToServiceId,
      svcToGroupTier,
      priorityToTier,
      DEFAULT_TIER
    )
    expect(out).toEqual(tightTier)
    expect(reason.tierSource).toBe('group')
    expect(reason.multiGroupCandidates).toHaveLength(2)
    expect(reason.multiGroupCandidates).toEqual(
      expect.arrayContaining([
        { tierName: 'Group', targetMinutes: 480 },
        { tierName: 'Tight', targetMinutes: 120 },
      ])
    )
  })

  it('unmapped keyword falls through to default, keyword recorded in unmappedKeywords', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis('NOT-IN-CATALOG')],
      priority: 'normal',
    }
    const { tier: out, reason } = resolveSampleTierWithReason(
      inputs,
      new Map(),
      new Map(),
      new Map(),
      DEFAULT_TIER
    )
    expect(out).toEqual(DEFAULT_TIER)
    expect(reason.tierSource).toBe('default')
    expect(reason.unmappedKeywords).toEqual(['NOT-IN-CATALOG'])
    expect(reason.multiGroupCandidates).toBeUndefined()
  })

  it('null keyword analyses are silently skipped (not added to unmappedKeywords)', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis(null), analysis('UNMAPPED')],
      priority: 'normal',
    }
    const { tier: out, reason } = resolveSampleTierWithReason(
      inputs,
      new Map(),
      new Map(),
      new Map(),
      DEFAULT_TIER
    )
    expect(out).toEqual(DEFAULT_TIER)
    expect(reason.tierSource).toBe('default')
    // Only 'UNMAPPED' should appear — null keywords never had a chance to map.
    expect(reason.unmappedKeywords).toEqual(['UNMAPPED'])
  })

  it('no resolution + no default → tier null, tierSource none', () => {
    const inputs: SampleSlaInputs = { analyses: [], priority: 'normal' }
    const { tier: out, reason } = resolveSampleTierWithReason(
      inputs,
      new Map(),
      new Map(),
      new Map(),
      null
    )
    expect(out).toBeNull()
    expect(reason.tierSource).toBe('none')
    expect(reason.unmappedKeywords).toEqual([])
  })

  it('priority slot present but no override mapping → falls through to group/default', () => {
    // Sample has priority 'expedited' but priorityToTier map has no entry.
    // Should NOT short-circuit on 'priority' — must fall through.
    const inputs: SampleSlaInputs = {
      analyses: [analysis('HPLC-100')],
      priority: 'expedited',
    }
    const svcToGroupTier = new Map<number, SlaTier>([[100, groupTier]])
    const keywordToServiceId = new Map<string, number>([['HPLC-100', 100]])
    const { tier: out, reason } = resolveSampleTierWithReason(
      inputs,
      keywordToServiceId,
      svcToGroupTier,
      new Map<InboxPriority, SlaTier>(),
      DEFAULT_TIER
    )
    expect(out).toEqual(groupTier)
    expect(reason.tierSource).toBe('group')
    expect(reason.priorityUsed).toBeUndefined()
  })
})

describe('classifySampleColor', () => {
  const t30 = tier(40, 'T30', 100, 30)

  it('breached → red (strict greater than target)', () => {
    expect(
      classifySampleColor(
        { target_minutes: 100, elapsed_minutes: 101, remaining_minutes: -1, breached: true },
        t30
      )
    ).toBe('red')
  })

  it('elapsed exactly at target is NOT breached → green', () => {
    expect(
      classifySampleColor(
        { target_minutes: 100, elapsed_minutes: 100, remaining_minutes: 0, breached: false },
        t30
      )
    ).toBe('green')
  })

  it('strictly less than amber_threshold_percent → amber', () => {
    expect(
      classifySampleColor(
        { target_minutes: 100, elapsed_minutes: 75, remaining_minutes: 25, breached: false },
        t30 // 25 < 30 → amber
      )
    ).toBe('amber')
  })

  it('at amber_threshold_percent exactly → green (strict <)', () => {
    expect(
      classifySampleColor(
        { target_minutes: 100, elapsed_minutes: 70, remaining_minutes: 30, breached: false },
        t30 // 30 is NOT < 30 → green
      )
    ).toBe('green')
  })

  it('healthy → green', () => {
    expect(
      classifySampleColor(
        { target_minutes: 100, elapsed_minutes: 10, remaining_minutes: 90, breached: false },
        t30
      )
    ).toBe('green')
  })

  it('target_minutes <= 0 defensive guard returns green', () => {
    expect(
      classifySampleColor(
        { target_minutes: 0, elapsed_minutes: 5, remaining_minutes: -5, breached: false },
        tier(99, 'broken', 0)
      )
    ).toBe('green')
  })
})

describe('aggregateOrderSlaVerdict', () => {
  const t = tier(50, 'Std', 100, 20)

  it('all published → met', () => {
    const v = aggregateOrderSlaVerdict([
      { senaiteId: 'a', tier: t, lookup: lookup(null, 'published', []), status: null, color: null },
      { senaiteId: 'b', tier: t, lookup: lookup(null, 'published', []), status: null, color: null },
    ])
    expect(v.color).toBe('met')
  })

  it('none received → awaiting', () => {
    const v = aggregateOrderSlaVerdict([
      { senaiteId: 'a', tier: t, lookup: lookup(null, 'sample_received', []), status: null, color: null },
    ])
    expect(v.color).toBe('awaiting')
  })

  it('worst-active selection: red beats amber beats green', () => {
    const samples = [
      {
        senaiteId: 'green',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 10, remaining_minutes: 90, breached: false },
        color: 'green' as const,
      },
      {
        senaiteId: 'amber',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 85, remaining_minutes: 15, breached: false },
        color: 'amber' as const,
      },
      {
        senaiteId: 'red',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 150, remaining_minutes: -50, breached: true },
        color: 'red' as const,
      },
    ]
    const v = aggregateOrderSlaVerdict(samples)
    expect(v.color).toBe('red')
    expect(v.drivingSampleId).toBe('red')
  })

  it('within red: most-over wins', () => {
    const samples = [
      {
        senaiteId: 'red-small',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 110, remaining_minutes: -10, breached: true },
        color: 'red' as const,
      },
      {
        senaiteId: 'red-big',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 300, remaining_minutes: -200, breached: true },
        color: 'red' as const,
      },
    ]
    expect(aggregateOrderSlaVerdict(samples).drivingSampleId).toBe('red-big')
  })

  it('within amber: least-percent-remaining wins', () => {
    const samples = [
      {
        senaiteId: 'amber-25pct',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 75, remaining_minutes: 25, breached: false },
        color: 'amber' as const,
      },
      {
        senaiteId: 'amber-5pct',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 95, remaining_minutes: 5, breached: false },
        color: 'amber' as const,
      },
    ]
    expect(aggregateOrderSlaVerdict(samples).drivingSampleId).toBe('amber-5pct')
  })

  it('mixed published + received: published excluded, received drives verdict', () => {
    const samples = [
      {
        senaiteId: 'pub',
        tier: t,
        lookup: lookup('2026-01-01', 'published', []),
        status: null,
        color: null,
      },
      {
        senaiteId: 'live',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 50, remaining_minutes: 50, breached: false },
        color: 'green' as const,
      },
    ]
    const v = aggregateOrderSlaVerdict(samples)
    expect(v.color).toBe('green')
    expect(v.drivingSampleId).toBe('live')
  })

  it('empty samples array returns awaiting', () => {
    expect(aggregateOrderSlaVerdict([]).color).toBe('awaiting')
  })
})

// ─── Multi-tier follow-on ────────────────────────────────────────────────────

const priorityRow = (
  id: number,
  priority: InboxPriority,
  sla_tier_id: number,
  service_group_id: number | null
): SlaPriorityTier => ({
  id,
  priority,
  sla_tier_id,
  service_group_id,
})

describe('buildServiceIdToGroupIdMap', () => {
  it('maps each member service to its group id', () => {
    const t = tier(2, 'HPLC', 1440)
    const groups = [group(10, 'HPLC', t.id, [100, 101])]
    const m = buildServiceIdToGroupIdMap(groups, new Map([[t.id, t]]))
    expect(m.get(100)).toBe(10)
    expect(m.get(101)).toBe(10)
  })

  it('when a service is in multiple groups, the tightest-tier group wins (matches buildServiceToGroupTierMap)', () => {
    const tFast = tier(3, 'Rush', 240) // tighter
    const tHplc = tier(2, 'HPLC', 1440)
    const groups = [
      group(10, 'HPLC', tHplc.id, [100]),
      group(11, 'Rush', tFast.id, [100]),
    ]
    const m = buildServiceIdToGroupIdMap(
      groups,
      new Map([
        [tHplc.id, tHplc],
        [tFast.id, tFast],
      ])
    )
    expect(m.get(100)).toBe(11)
  })

  it('a group with no tier still claims its members (so the resolver can fall through to default for them)', () => {
    const groups = [group(10, 'Untiered', null, [100])]
    const m = buildServiceIdToGroupIdMap(groups, new Map())
    // Service 100 is mapped to group 10 even though group 10 has no tier;
    // resolveSampleTiersByGroup will fall through to default for this group.
    expect(m.get(100)).toBe(10)
  })
})

describe('buildGroupIdToTierMap', () => {
  it('maps groups with a tier id to their tier; omits groups without one', () => {
    const t = tier(2, 'HPLC', 1440)
    const groups = [
      group(10, 'HPLC', t.id, [100]),
      group(11, 'Untiered', null, [101]),
    ]
    const m = buildGroupIdToTierMap(groups, new Map([[t.id, t]]))
    expect(m.get(10)).toBe(t)
    expect(m.has(11)).toBe(false)
  })
})

describe('buildGlobalPriorityToTierMap', () => {
  it('keeps only NULL-group rows, keyed by priority', () => {
    const t = tier(5, 'Expedited 4h', 240)
    const rows = [
      priorityRow(1, 'expedited', t.id, null), // global — kept
      priorityRow(2, 'expedited', t.id, 10),   // per-group — skipped
    ]
    const m = buildGlobalPriorityToTierMap(rows, new Map([[t.id, t]]))
    expect(m.get('expedited')).toBe(t)
    expect(m.size).toBe(1)
  })
})

describe('buildPerGroupPriorityToTierMap', () => {
  it('keys per-group rows by `${priority}|${groupId}` and skips NULL-group rows', () => {
    const t = tier(5, 'Expedited 4h', 240)
    const rows = [
      priorityRow(1, 'expedited', t.id, null), // global — skipped
      priorityRow(2, 'expedited', t.id, 10),   // per-group — kept
    ]
    const m = buildPerGroupPriorityToTierMap(rows, new Map([[t.id, t]]))
    expect(m.get('expedited|10')).toBe(t)
    expect(m.size).toBe(1)
  })
})

describe('resolveSampleTiersByGroup', () => {
  // Fixture: HPLC group with 24h tier, Sterility group with 7d tier, default tier.
  const HPLC_TIER = tier(2, 'HPLC', 1440)
  const STER_TIER = tier(3, 'Sterility', 10080)
  const EXPEDITED_TIER = tier(5, 'Expedited 4h', 240)

  const services = [
    svc(100, 'kw_hplc'),
    svc(101, 'kw_endo'),     // sterility
    svc(102, 'kw_sterility'), // sterility
  ]
  const groups = [
    group(10, 'HPLC', HPLC_TIER.id, [100]),
    group(11, 'Sterility', STER_TIER.id, [101, 102]),
  ]
  const tiersById = new Map<number, SlaTier>([
    [HPLC_TIER.id, HPLC_TIER],
    [STER_TIER.id, STER_TIER],
    [EXPEDITED_TIER.id, EXPEDITED_TIER],
    [DEFAULT_TIER.id, DEFAULT_TIER],
  ])
  const keywordToServiceId = buildKeywordToServiceIdMap(services)
  const serviceIdToGroupId = buildServiceIdToGroupIdMap(groups, tiersById)
  const groupIdToTier = buildGroupIdToTierMap(groups, tiersById)

  it('sample with analyses in one group resolves to that group\'s tier', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis('kw_hplc')],
      priority: null,
    }
    const m = resolveSampleTiersByGroup(
      inputs,
      keywordToServiceId,
      serviceIdToGroupId,
      groupIdToTier,
      new Map(),
      new Map(),
      DEFAULT_TIER
    )
    expect(m.size).toBe(1)
    expect(m.get(10)?.tier).toBe(HPLC_TIER)
    expect(m.get(10)?.reason.tierSource).toBe('group')
  })

  it('sample spanning HPLC + Sterility resolves to both groups\' tiers with no priority', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis('kw_hplc'), analysis('kw_endo'), analysis('kw_sterility')],
      priority: null,
    }
    const m = resolveSampleTiersByGroup(
      inputs,
      keywordToServiceId,
      serviceIdToGroupId,
      groupIdToTier,
      new Map(),
      new Map(),
      DEFAULT_TIER
    )
    expect(m.size).toBe(2)
    expect(m.get(10)?.tier).toBe(HPLC_TIER)
    expect(m.get(11)?.tier).toBe(STER_TIER)
    expect(m.get(10)?.reason.tierSource).toBe('group')
    expect(m.get(11)?.reason.tierSource).toBe('group')
  })

  it('expedited with ONLY a global override applies the expedited tier to both groups', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis('kw_hplc'), analysis('kw_endo')],
      priority: 'expedited',
    }
    const globalMap = new Map<InboxPriority, SlaTier>([['expedited', EXPEDITED_TIER]])
    const m = resolveSampleTiersByGroup(
      inputs,
      keywordToServiceId,
      serviceIdToGroupId,
      groupIdToTier,
      globalMap,
      new Map(),
      DEFAULT_TIER
    )
    expect(m.get(10)?.tier).toBe(EXPEDITED_TIER)
    expect(m.get(11)?.tier).toBe(EXPEDITED_TIER)
    expect(m.get(10)?.reason.priorityScope).toBe('global')
    expect(m.get(11)?.reason.priorityScope).toBe('global')
  })

  it('expedited + per-group override on HPLC keeps Sterility on its own group tier (the load-bearing case)', () => {
    // This is the lab's stated requirement: expedited speeds up HPLC but does
    // nothing for sterility (which still takes 7 days).
    const inputs: SampleSlaInputs = {
      analyses: [analysis('kw_hplc'), analysis('kw_sterility')],
      priority: 'expedited',
    }
    const perGroupMap = new Map<string, SlaTier>([
      [`expedited|${10}`, EXPEDITED_TIER], // expedited only on HPLC group
    ])
    const m = resolveSampleTiersByGroup(
      inputs,
      keywordToServiceId,
      serviceIdToGroupId,
      groupIdToTier,
      new Map(), // no global override
      perGroupMap,
      DEFAULT_TIER
    )
    expect(m.get(10)?.tier).toBe(EXPEDITED_TIER)
    expect(m.get(10)?.reason.priorityScope).toBe('group')
    expect(m.get(11)?.tier).toBe(STER_TIER)
    expect(m.get(11)?.reason.tierSource).toBe('group')
  })

  it('per-group override beats global override when both are configured for the same priority', () => {
    const FASTER_TIER = tier(6, 'Faster HPLC', 60)
    const tiersExtended = new Map(tiersById)
    tiersExtended.set(FASTER_TIER.id, FASTER_TIER)
    const inputs: SampleSlaInputs = {
      analyses: [analysis('kw_hplc'), analysis('kw_sterility')],
      priority: 'expedited',
    }
    const globalMap = new Map<InboxPriority, SlaTier>([['expedited', EXPEDITED_TIER]])
    const perGroupMap = new Map<string, SlaTier>([[`expedited|${10}`, FASTER_TIER]])
    const m = resolveSampleTiersByGroup(
      inputs,
      keywordToServiceId,
      serviceIdToGroupId,
      groupIdToTier,
      globalMap,
      perGroupMap,
      DEFAULT_TIER
    )
    expect(m.get(10)?.tier).toBe(FASTER_TIER) // per-group wins
    expect(m.get(10)?.reason.priorityScope).toBe('group')
    expect(m.get(11)?.tier).toBe(EXPEDITED_TIER) // sterility falls to global
    expect(m.get(11)?.reason.priorityScope).toBe('global')
  })

  it('unmapped keywords go into the no-group bucket with default tier and surface in reason.unmappedKeywords', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis('kw_unmapped_xyz')],
      priority: null,
    }
    const m = resolveSampleTiersByGroup(
      inputs,
      keywordToServiceId,
      serviceIdToGroupId,
      groupIdToTier,
      new Map(),
      new Map(),
      DEFAULT_TIER
    )
    expect(m.size).toBe(1)
    const entry = m.get(NO_GROUP_KEY)
    expect(entry?.tier).toBe(DEFAULT_TIER)
    expect(entry?.reason.tierSource).toBe('default')
    expect(entry?.reason.unmappedKeywords).toContain('kw_unmapped_xyz')
  })

  it('service-with-no-group goes to no-group bucket and uses default tier', () => {
    // svc(200) exists but is in no group.
    const orphanServices = [...services, svc(200, 'kw_orphan')]
    const orphanKwMap = buildKeywordToServiceIdMap(orphanServices)
    const inputs: SampleSlaInputs = {
      analyses: [analysis('kw_orphan')],
      priority: null,
    }
    const m = resolveSampleTiersByGroup(
      inputs,
      orphanKwMap,
      serviceIdToGroupId,
      groupIdToTier,
      new Map(),
      new Map(),
      DEFAULT_TIER
    )
    expect(m.size).toBe(1)
    expect(m.get(NO_GROUP_KEY)?.tier).toBe(DEFAULT_TIER)
    // Orphan kw is NOT in unmappedKeywords — the service WAS mapped, just has no group.
    expect(m.get(NO_GROUP_KEY)?.reason.unmappedKeywords).toEqual([])
  })

  it('no-group bucket cannot use per-group priority override (only global)', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis('kw_unmapped_xyz')], // forces no-group bucket
      priority: 'expedited',
    }
    // Per-group override exists for the no-group bucket somehow (NO_GROUP_KEY is a string).
    // The resolver MUST ignore it — per-group only applies to real groups.
    const perGroupMap = new Map<string, SlaTier>([
      [`expedited|${NO_GROUP_KEY}`, EXPEDITED_TIER],
    ])
    const m = resolveSampleTiersByGroup(
      inputs,
      keywordToServiceId,
      serviceIdToGroupId,
      groupIdToTier,
      new Map(), // no global
      perGroupMap,
      DEFAULT_TIER
    )
    // Falls through to default — per-group key wasn't honored for the no-group bucket.
    expect(m.get(NO_GROUP_KEY)?.tier).toBe(DEFAULT_TIER)
  })

  it('empty analyses array returns an empty map (no bucket exists)', () => {
    const m = resolveSampleTiersByGroup(
      { analyses: [], priority: null },
      keywordToServiceId,
      serviceIdToGroupId,
      groupIdToTier,
      new Map(),
      new Map(),
      DEFAULT_TIER
    )
    expect(m.size).toBe(0)
  })

  it('no default tier + unmapped keywords → no-group bucket with tier=null and tierSource=none', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis('kw_unmapped_xyz')],
      priority: null,
    }
    const m = resolveSampleTiersByGroup(
      inputs,
      keywordToServiceId,
      serviceIdToGroupId,
      groupIdToTier,
      new Map(),
      new Map(),
      null // no default
    )
    expect(m.get(NO_GROUP_KEY)?.tier).toBeNull()
    expect(m.get(NO_GROUP_KEY)?.reason.tierSource).toBe('none')
  })
})
