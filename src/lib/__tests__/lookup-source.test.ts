import { describe, it, expect, vi, beforeEach } from 'vitest'
import { lookupSenaiteSample } from '@/lib/api'
import { enqueueSenaiteLookup } from '@/components/explorer/senaite-queue'

const emptyResult = {
  sample_id: 'PB-0073',
  sample_uid: null,
  client: null,
  contact: null,
  sample_type: null,
  date_received: null,
  date_sampled: null,
  profiles: [],
  client_order_number: null,
  client_sample_id: null,
  client_lot: null,
  review_state: null,
  declared_weight_mg: null,
  analytes: [],
  coa: null,
  remarks: [],
  analyses: [],
  attachments: [],
  published_coa: null,
  senaite_url: null,
  cached_at: null,
}

describe('lookupSenaiteSample source routing', () => {
  beforeEach(() => vi.restoreAllMocks())

  it("routes source 'mk1' to the registry details endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => emptyResult,
    })
    vi.stubGlobal('fetch', fetchMock)

    await lookupSenaiteSample('PB-0073', true, 'mk1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('/registry/sample/PB-0073/details')
    expect(url).not.toContain('/wizard/senaite/lookup')
  })

  it("routes source 'senaite' to the existing SENAITE lookup endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => emptyResult,
    })
    vi.stubGlobal('fetch', fetchMock)

    await lookupSenaiteSample('PB-0073', true, 'senaite')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('/wizard/senaite/lookup')
    expect(url).not.toContain('/registry/sample/')
  })

  it('defaults to the SENAITE lookup endpoint when source is omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => emptyResult,
    })
    vi.stubGlobal('fetch', fetchMock)

    await lookupSenaiteSample('PB-0073')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('/wizard/senaite/lookup')
  })
})

// The 'sample_details' two-tier read-source setting resolves to a
// ReadSource via useEffectiveReadSource('sample_details') (deeply tested in
// read-source.test.ts / effective-read-source.test.ts — resolution is
// generic over PageKey, not re-tested here). What's new in this task is the
// consumer side: enqueueSenaiteLookup (the serialized queue shared by
// CustomerStatusPage/OrderExplorer/OrderStatusPage/OrderDashboard via
// useSenaiteLookupMap) threading that resolved source through to
// lookupSenaiteSample instead of hardcoding 'senaite'.
describe('enqueueSenaiteLookup source threading', () => {
  beforeEach(() => vi.restoreAllMocks())

  it("threads source 'mk1' through to the registry details endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => emptyResult,
    })
    vi.stubGlobal('fetch', fetchMock)

    await enqueueSenaiteLookup('PB-0073', 'mk1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('/registry/sample/PB-0073/details')
  })

  it("defaults to 'senaite' when no source is passed (pre-flip behavior preserved)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => emptyResult,
    })
    vi.stubGlobal('fetch', fetchMock)

    await enqueueSenaiteLookup('PB-0073')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('/wizard/senaite/lookup')
  })
})
