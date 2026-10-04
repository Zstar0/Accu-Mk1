/** TanStack Query hooks for document comments. Mirrors services/documents.ts. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  createDocumentComment,
  deleteDocumentComment,
  listCommentLabels,
  listDocumentComments,
  patchDocumentComment,
  setDocumentCommentStatus,
  type CommentCreate,
  type CommentPatch,
  type CommentStatus,
  type CommentStatusFilter,
} from '@/lib/api-document-comments'
import { documentKeys } from '@/services/documents'

export const commentKeys = {
  all: ['document-comments'] as const,
  list: (docId: number, status: CommentStatusFilter) =>
    ['document-comments', 'list', docId, status] as const,
  labels: ['document-comments', 'labels'] as const,
}

export function useDocumentComments(
  docId: number | null,
  status: CommentStatusFilter = 'open'
) {
  return useQuery({
    queryKey: commentKeys.list(docId ?? -1, status),
    queryFn: () => listDocumentComments(docId as number, status),
    enabled: docId != null,
    refetchOnWindowFocus: true, // no SSE in v1 (spec §2)
  })
}

export function useCommentLabels() {
  return useQuery({
    queryKey: commentKeys.labels,
    queryFn: listCommentLabels,
    staleTime: Infinity,
  })
}

function useInvalidateComments(docId: number) {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: commentKeys.all })
    void qc.invalidateQueries({ queryKey: documentKeys.detail(docId) })
    void qc.invalidateQueries({ queryKey: documentKeys.lists })
  }
}

export function useCreateComment(docId: number) {
  const invalidate = useInvalidateComments(docId)
  return useMutation({
    mutationFn: (body: CommentCreate) => createDocumentComment(docId, body),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
}

export function usePatchComment(docId: number) {
  const invalidate = useInvalidateComments(docId)
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: CommentPatch }) =>
      patchDocumentComment(id, body),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteComment(docId: number) {
  const invalidate = useInvalidateComments(docId)
  return useMutation({
    mutationFn: (id: number) => deleteDocumentComment(id),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useSetCommentStatus(docId: number) {
  const invalidate = useInvalidateComments(docId)
  return useMutation({
    mutationFn: ({ id, status }: { id: number; status: CommentStatus }) =>
      setDocumentCommentStatus(id, status),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
}
