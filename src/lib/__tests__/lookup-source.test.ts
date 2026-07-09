import { describe, it, expect, vi, beforeEach } from 'vitest'
import { lookupSenaiteSample } from '@/lib/api'

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
