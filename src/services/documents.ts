/**
 * TanStack Query hooks for the Documents library. Mirrors services/flag-types.ts.
 */
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  createDocumentCategory,
  createDocumentRevision,
  deleteDocumentCategory,
  getDocument,
  getDocumentContent,
  listDocumentCategories,
  listDocuments,
  patchDocument,
  replaceDraftContent,
  updateDocumentCategory,
  type DocumentCategoryCreate,
  type DocumentCategoryUpdate,
  type DocumentDetail,
  type DocumentPatch,
} from '@/lib/api-documents'
import type { DocumentListParams } from '@/components/documents/documents-utils'

export const documentKeys = {
  all: ['documents'] as const,
  lists: ['documents', 'list'] as const,
  list: (params: DocumentListParams) => ['documents', 'list', params] as const,
  details: ['documents', 'detail'] as const,
  detail: (id: number) => ['documents', 'detail', id] as const,
  // Keyed by the hash too: a draft's bytes change in place (PUT /content), so
  // the shown bytes must always be the ones the detail's hash describes.
  content: (id: number, sha?: string) =>
    ['documents', 'content', id, sha] as const,
  allCategories: ['documents', 'categories'] as const,
  categories: (activeOnly: boolean) =>
    ['documents', 'categories', activeOnly] as const,
}

export function useDocuments(params: DocumentListParams) {
  return useQuery({
    queryKey: documentKeys.list(params),
    queryFn: () => listDocuments(params),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })
}

export function useDocument(id: number | null) {
  return useQuery({
    queryKey: documentKeys.detail(id ?? -1),
    queryFn: () => getDocument(id as number),
    enabled: id != null,
  })
}

export function useDocumentContent(id: number | null, sha?: string) {
  return useQuery({
    queryKey: documentKeys.content(id ?? -1, sha),
    queryFn: () => getDocumentContent(id as number),
    enabled: id != null && sha != null,
    staleTime: Infinity, // immutable per (revision, hash)
  })
}

export function usePatchDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: DocumentPatch }) =>
      patchDocument(id, data),
    // Lists and this document's detail only — content is immutable per
    // revision, so refetching it on a metadata patch is pure waste.
    onSuccess: (_updated, { id }) => {
      qc.invalidateQueries({ queryKey: documentKeys.lists })
      qc.invalidateQueries({ queryKey: documentKeys.detail(id) })
      toast.success('Document updated')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useReplaceDraftContent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      html,
      expectedSha256,
    }: {
      id: number
      html: string
      expectedSha256?: string
    }) => replaceDraftContent(id, html, expectedSha256),
    onSuccess: (row, { id }) => {
      // The next save in this session must send the NEW hash, even before the
      // detail refetch lands, or it would 409 against itself.
      qc.setQueryData<DocumentDetail>(documentKeys.detail(id), old =>
        old ? { ...old, content_sha256: row.content_sha256 } : old
      )
      // No content invalidation: the caller seeds the new (id, hash) key
      // with the bytes it saved, and the old key is never shown again.
      qc.invalidateQueries({ queryKey: documentKeys.detail(id) })
      qc.invalidateQueries({ queryKey: documentKeys.lists })
      toast.success('Draft updated')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useCreateRevision() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      code,
      html,
      author,
    }: {
      code: string
      html: string
      author?: string
    }) => createDocumentRevision(code, html, author),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: documentKeys.lists })
      // Every cached detail of the code lists its revisions; a stale one
      // would keep Edit live on a revision that is no longer the latest.
      qc.invalidateQueries({ queryKey: documentKeys.details })
      toast.success('Saved as a new draft revision')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDocumentCategories(activeOnly = false) {
  return useQuery({
    queryKey: documentKeys.categories(activeOnly),
    queryFn: () => listDocumentCategories(activeOnly),
    staleTime: 5 * 60_000,
  })
}

function invalidateCategories(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: documentKeys.allCategories })
  qc.invalidateQueries({ queryKey: documentKeys.lists })
}

export function useCreateDocumentCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: DocumentCategoryCreate) => createDocumentCategory(data),
    onSuccess: () => {
      invalidateCategories(qc)
      toast.success('Category created')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdateDocumentCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: DocumentCategoryUpdate }) =>
      updateDocumentCategory(id, data),
    onSuccess: () => {
      invalidateCategories(qc)
      toast.success('Category updated')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteDocumentCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteDocumentCategory(id),
    onSuccess: () => {
      invalidateCategories(qc)
      toast.success('Category deleted')
    },
    // 409 = still referenced. The pane hides Delete at a non-zero count, but the
    // list can be stale, so say what happened instead of failing silently.
    onError: (e: Error) => {
      if (/failed: 409/.test(e.message)) {
        toast.error(
          'Category is still referenced by documents; deactivate it instead'
        )
        return
      }
      toast.error(e.message)
    },
  })
}
