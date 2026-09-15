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
  deleteDocumentCategory,
  getDocument,
  getDocumentContent,
  listDocumentCategories,
  listDocuments,
  patchDocument,
  updateDocumentCategory,
  type DocumentCategoryCreate,
  type DocumentCategoryUpdate,
  type DocumentPatch,
} from '@/lib/api-documents'
import type { DocumentListParams } from '@/components/documents/documents-utils'

export const documentKeys = {
  all: ['documents'] as const,
  lists: ['documents', 'list'] as const,
  list: (params: DocumentListParams) => ['documents', 'list', params] as const,
  detail: (id: number) => ['documents', 'detail', id] as const,
  content: (id: number) => ['documents', 'content', id] as const,
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

export function useDocumentContent(id: number | null) {
  return useQuery({
    queryKey: documentKeys.content(id ?? -1),
    queryFn: () => getDocumentContent(id as number),
    enabled: id != null,
    staleTime: Infinity, // content is immutable per revision
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
    onSuccess: () => invalidateCategories(qc),
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
    // 409 = still referenced; the pane explains and offers Deactivate instead.
    onError: (e: Error) => {
      if (/failed: 409/.test(e.message)) return
      toast.error(e.message)
    },
  })
}
