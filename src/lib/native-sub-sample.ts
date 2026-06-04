import type { ParentSampleSummary, SenaiteLookupResult, SubSample } from '@/lib/api'

/**
 * Phase 5d read-side: build the SampleDetails page `data` object for a Model-D
 * native vial (one with no SENAITE AR) entirely from Mk1 data, so the page
 * never calls SENAITE for it.
 *
 * Native vials only exist in Mk1, so the SENAITE-only fields (client, contact,
 * declared weight, analytes, profiles, COA branding) are left blank — they live
 * on the parent AR, which this page doesn't need to render a vial. The analyses
 * array is left empty here; the existing Phase 3 effect fills it from Mk1.
 */
export function buildNativeSubSampleLookup(
  sub: SubSample,
  parent: ParentSampleSummary,
): SenaiteLookupResult {
  return {
    sample_id: sub.sample_id,
    sample_uid: sub.external_lims_uid ?? null,
    client: null,
    contact: null,
    sample_type: null,
    date_received: sub.received_at,
    date_sampled: null,
    profiles: [],
    client_order_number: null,
    client_sample_id: null,
    client_lot: null,
    // The vial has no single state of its own; surface the parent's lifecycle
    // status as a loose indicator.
    review_state: parent.status ?? null,
    declared_weight_mg: null,
    analytes: [],
    coa: {
      company_logo_url: null,
      chromatograph_background_url: null,
      company_name: null,
      email: null,
      website: null,
      address: null,
      verification_code: null,
    },
    remarks: [],
    analyses: [], // filled by the Phase 3 Mk1 analyses swap effect
    attachments: [], // the vial photo is fetched via the Mk1 photo route separately
    published_coa: null,
    senaite_url: null,
    cached_at: null,
  }
}
