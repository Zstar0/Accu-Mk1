/**
 * Documents library API client (spec 2026-09-15 §5). A sibling of api.ts,
 * like api-priorities.ts, so the 8k-line client does not grow further.
 */
import { API_BASE_URL, apiFetch, getBearerHeaders } from '@/lib/api'
import {
  buildDocumentListQuery,
  type DocumentListParams,
  type DocumentStatus,
} from '@/components/documents/documents-utils'

export interface DocumentCategory {
  id: number
  name: string
  code_prefix: string
  description: string | null
  sort_order: number
  active: boolean
  document_count: number
  created_at: string
  updated_at: string
}

export interface DocumentRow {
  id: number
  code: string
  revision: number
  title: string
  description: string | null
  category_id: number
  category_name: string
  category_prefix: string
  status: DocumentStatus
  effective_date: string | null
  activated_at: string | null
  retired_at: string | null
  supersedes_id: number | null
  author: string | null
  updated_by: string | null
  source_session: string | null
  created_by_user_id: number | null
  content_type: string
  size_bytes: number
  content_sha256: string
  created_at: string
  updated_at: string
  revision_count: number
}

export interface DocumentDetail extends DocumentRow {
  revisions: DocumentRow[]
}

export interface DocumentListResponse {
  items: DocumentRow[]
  total: number
  page: number
  page_size: number
}

export interface DocumentPatch {
  title?: string
  description?: string | null
  category_id?: number
  effective_date?: string | null
}

export interface DocumentCategoryCreate {
  name: string
  code_prefix: string
  description?: string | null
  sort_order?: number
}

export interface DocumentCategoryUpdate {
  name?: string
  description?: string | null
  sort_order?: number
  active?: boolean
}

export function listDocuments(
  params: DocumentListParams
): Promise<DocumentListResponse> {
  return apiFetch<DocumentListResponse>(
    `/api/documents?${buildDocumentListQuery(params)}`
  )
}

export function getDocument(id: number): Promise<DocumentDetail> {
  return apiFetch<DocumentDetail>(`/api/documents/${id}`)
}

/** Raw HTML. apiFetch hardcodes response.json(), so this one uses fetch directly. */
export async function getDocumentContent(id: number): Promise<string> {
  const response = await fetch(
    `${API_BASE_URL()}/api/documents/${id}/content`,
    {
      headers: getBearerHeaders(),
    }
  )
  if (!response.ok) {
    throw new Error(
      `GET /api/documents/${id}/content failed: ${response.status}`
    )
  }
  return response.text()
}

export function patchDocument(
  id: number,
  data: DocumentPatch
): Promise<DocumentRow> {
  return apiFetch<DocumentRow>(`/api/documents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export function activateDocument(id: number): Promise<DocumentRow> {
  return apiFetch<DocumentRow>(`/api/documents/${id}/activate`, {
    method: 'POST',
  })
}

export function retireDocument(id: number): Promise<DocumentRow> {
  return apiFetch<DocumentRow>(`/api/documents/${id}/retire`, {
    method: 'POST',
  })
}

export function listDocumentCategories(
  activeOnly = false
): Promise<DocumentCategory[]> {
  return apiFetch<DocumentCategory[]>(
    `/api/document-categories${activeOnly ? '?active_only=true' : ''}`
  )
}

export function createDocumentCategory(
  data: DocumentCategoryCreate
): Promise<DocumentCategory> {
  return apiFetch<DocumentCategory>('/api/document-categories', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function updateDocumentCategory(
  id: number,
  data: DocumentCategoryUpdate
): Promise<DocumentCategory> {
  return apiFetch<DocumentCategory>(`/api/document-categories/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export function deleteDocumentCategory(id: number): Promise<void> {
  // apiFetch returns undefined on 204; <undefined> matches flags-api.ts and
  // keeps @typescript-eslint/no-invalid-void-type happy.
  return apiFetch<undefined>(`/api/document-categories/${id}`, {
    method: 'DELETE',
  })
}
