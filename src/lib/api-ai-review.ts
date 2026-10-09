import { crmFetch } from '@/lib/api-crm'
import type { CrmItem } from '@/lib/api-crm'
import type { SupportThread } from '@/lib/api-support'

export interface ReviewCitation {
  kind: 'ticket' | 'crm' | 'sample' | 'order'
  id: string
  label: string
  thread?: Partial<SupportThread> & { id: string; ref: string }
  item?: CrmItem
  order_id?: string
}

export interface ReviewItem {
  title: string
  detail: string
  severity?: 'high' | 'medium' | 'low'
  theme?: string
  citations: ReviewCitation[]
}

export interface Review {
  headline: string
  sentiment: {
    score: number
    trend: 'improving' | 'steady' | 'declining'
    reason: string
    citations: ReviewCitation[]
    unsupported: boolean
  }
  open_issues: ReviewItem[]
  shortfalls: ReviewItem[]
  strengths: ReviewItem[]
  next_steps: ReviewItem[]
}

export interface ReviewRun {
  run_id: number
  customer_key: string
  status: 'running' | 'done' | 'failed' | 'interrupted'
  created_at: string | null
  finished_at: string | null
  model: string
  steps: { at: string; tool: string; label: string }[]
  review: Review | null
  tool_calls: {
    tool: string
    args: Record<string, unknown>
    ok: boolean
    size: number
  }[]
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cost_usd: number
  citations_dropped: number
  error: string | null
  document_id: number | null
  document_code: string | null
  names_scrubbed: number
  document_error: string | null
}

export interface CustomerReviews {
  latest: ReviewRun | null
  history: {
    run_id: number
    status: string
    created_at: string | null
    sentiment_score: number | null
  }[]
}

const enc = encodeURIComponent

export function startReview(
  key: string
): Promise<{ run_id: number; status: string }> {
  return crmFetch(`/ai-review/customers/${enc(key)}`, new URLSearchParams(), {
    method: 'POST',
  })
}

export function getReviews(key: string): Promise<CustomerReviews> {
  return crmFetch(`/ai-review/customers/${enc(key)}`, new URLSearchParams())
}

export function getReviewRun(id: number): Promise<ReviewRun> {
  return crmFetch(`/ai-review/runs/${id}`, new URLSearchParams())
}
