/**
 * Document comments API client (spec 2026-10-03 §6). A sibling of api-documents.ts.
 * Create/patch use raw fetch so the server's `detail` ("quote not found…",
 * "anchor is N bytes…") reaches the composer; apiFetch only reports the status.
 */
import { API_BASE_URL, apiFetch, getBearerHeaders } from '@/lib/api'

export type CommentKind = 'comment' | 'suggestion'
export type CommentStatus = 'open' | 'resolved'
export type CommentStatusFilter = CommentStatus | 'all'

export interface HtmlAnchorPoint {
  x: number
  y: number
}
export interface HtmlElementAnchor {
  selector: string
  tagName: string
  text?: string
  point?: HtmlAnchorPoint
}
export interface HtmlAnnotationTarget {
  label?: string
  text: string
  anchor?: HtmlElementAnchor
  context?: Record<string, unknown>
}
/** Stored verbatim as plannotator's PersistedHtmlAnchor; null = document-level. */
export interface CommentAnchor {
  originalText: string
  htmlAnchor?: HtmlElementAnchor
  htmlAdditionalTargets?: HtmlAnnotationTarget[]
  elementContext?: Record<string, unknown> & { heading?: string; path?: string }
}
export interface CommentAttachment {
  id: number
  filename: string
  content_type: string
  size_bytes: number
  created_at: string
}
export interface DocumentComment {
  id: number
  code: string
  document_id: number
  revision: number
  parent_id: number | null
  number: number | null
  kind: CommentKind
  anchor: CommentAnchor | null
  label: string | null
  body: string
  suggested_text: string | null
  author: string
  author_user_id: number | null
  author_agent: string | null
  status: CommentStatus
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  updated_at: string
  edited_at: string | null
  attachments: CommentAttachment[]
  replies: DocumentComment[]
}
export interface CommentListResponse {
  items: DocumentComment[]
  code: string
  latest_revision: number
  open_count: number
}
export interface CommentCreate {
  parent_id?: number
  kind?: CommentKind
  anchor?: CommentAnchor | null
  label?: string | null
  body: string
  suggested_text?: string | null
}
export interface CommentPatch {
  body?: string
  suggested_text?: string
}
export interface CommentLabel {
  id: string
  emoji: string
  text: string
  color: string
  tip: string | null
}

async function errorDetail(res: Response, ctx: string): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: unknown }
    if (typeof j?.detail === 'string') return j.detail
  } catch {
    /* not json */
  }
  return `${ctx} failed: ${res.status}`
}

export function listDocumentComments(
  docId: number,
  status: CommentStatusFilter = 'open'
) {
  return apiFetch<CommentListResponse>(
    `/api/documents/${docId}/comments?status=${status}`
  )
}

export async function createDocumentComment(
  docId: number,
  body: CommentCreate
): Promise<DocumentComment> {
  const path = `/api/documents/${docId}/comments`
  const res = await fetch(`${API_BASE_URL()}${path}`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorDetail(res, `POST ${path}`))
  return (await res.json()) as DocumentComment
}

export async function patchDocumentComment(
  id: number,
  body: CommentPatch
): Promise<DocumentComment> {
  const path = `/api/documents/comments/${id}`
  const res = await fetch(`${API_BASE_URL()}${path}`, {
    method: 'PATCH',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorDetail(res, `PATCH ${path}`))
  return (await res.json()) as DocumentComment
}

export async function deleteDocumentComment(id: number): Promise<void> {
  const res = await fetch(`${API_BASE_URL()}/api/documents/comments/${id}`, {
    method: 'DELETE',
    headers: getBearerHeaders(),
  })
  if (!res.ok)
    throw new Error(
      `DELETE /api/documents/comments/${id} failed: ${res.status}`
    )
}

export function setDocumentCommentStatus(id: number, status: CommentStatus) {
  const verb = status === 'resolved' ? 'resolve' : 'reopen'
  return apiFetch<DocumentComment>(`/api/documents/comments/${id}/${verb}`, {
    method: 'POST',
  })
}

export function listCommentLabels() {
  return apiFetch<CommentLabel[]>('/api/documents/comment-labels')
}

export async function addDocumentCommentAttachment(
  docId: number,
  file: Blob,
  name = 'image.png'
): Promise<CommentAttachment> {
  const form = new FormData()
  form.append('file', file, name)
  const res = await fetch(
    `${API_BASE_URL()}/api/documents/${docId}/comment-attachments`,
    {
      method: 'POST',
      headers: getBearerHeaders(),
      body: form,
    }
  )
  if (!res.ok) throw new Error(await errorDetail(res, 'attachment upload'))
  return (await res.json()) as CommentAttachment
}

const _urlCache = new Map<number, string>()
/** Bearer-authed blob URL for an attachment (the backend serves bytes, never public URLs). */
export async function fetchDocumentCommentAttachmentUrl(
  id: number
): Promise<string | null> {
  const cached = _urlCache.get(id)
  if (cached) return cached
  const res = await fetch(
    `${API_BASE_URL()}/api/documents/comment-attachments/${id}`,
    {
      headers: getBearerHeaders(),
    }
  )
  if (res.status === 404) return null
  if (!res.ok)
    throw new Error(`fetchDocumentCommentAttachmentUrl failed: ${res.status}`)
  const url = URL.createObjectURL(await res.blob())
  _urlCache.set(id, url)
  return url
}
