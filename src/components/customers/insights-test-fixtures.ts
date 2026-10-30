import type { CustomerRow, Touchpoints } from '@/lib/api'
import type { useTouchpoints } from './useTouchpoints'

export function row(over: Partial<CustomerRow> = {}): CustomerRow {
  return {
    key: 'wc:1',
    name: 'Test Customer',
    email: 'test@example.com',
    company: null,
    rep: null,
    period_spend: '1000.00',
    prior_spend: '0.00',
    delta_pct: null,
    lifetime: '1000.00',
    orders: 1,
    samples: 4,
    usual_gap_days: null,
    last_order_at: '2026-09-01T15:00:00Z',
    first_order_at: '2026-09-01T15:00:00Z',
    testing_orders: 1,
    spend_12m: '0.00',
    testing_orders_12m: 0,
    samples_12m: 0,
    segment: null,
    top_tests: [],
    status: 'steady',
    monthly: [],
    ...over,
  }
}

export function touch(
  over: {
    crmVisible?: boolean
    supportVisible?: boolean
    rows?: Record<string, Touchpoints>
  } = {}
): ReturnType<typeof useTouchpoints> {
  return {
    rows: over.rows ?? {},
    crmVisible: over.crmVisible ?? false,
    supportVisible: over.supportVisible ?? false,
    isLoading: false,
  }
}
