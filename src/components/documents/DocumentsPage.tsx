import { useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useQuery } from '@tanstack/react-query'
import { FileText, Loader2, MessageSquare } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/ui/data-table'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useUIStore } from '@/store/ui-store'
import { flagKeys } from '@/hooks/use-flags'
import { listFlags } from '@/lib/flags-api'
import { useDocumentCategories, useDocuments } from '@/services/documents'
import type { DocumentRow } from '@/lib/api-documents'
import {
  DEFAULT_STATUSES,
  DOC_STATUS_LABEL,
  formatDocDate,
  type DocumentSort,
  type DocumentStatus,
} from '@/components/documents/documents-utils'
import { DocumentViewer } from '@/components/documents/DocumentViewer'

const PAGE_SIZE = 50

type StatusFilter = 'live' | 'active' | 'draft' | 'retired' | 'all'

const STATUS_FILTERS: Record<StatusFilter, DocumentStatus[]> = {
  live: [...DEFAULT_STATUSES],
  active: ['active'],
  draft: ['draft'],
  retired: ['retired'],
  all: ['draft', 'active', 'retired'],
}

const STATUS_BADGE: Record<
  DocumentStatus,
  'default' | 'secondary' | 'outline'
> = {
  active: 'default',
  draft: 'secondary',
  retired: 'outline',
}

export function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <Badge variant={STATUS_BADGE[status]}>{DOC_STATUS_LABEL[status]}</Badge>
  )
}

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

export function DocumentsPage() {
  const targetId = useUIStore(s => s.documentViewerTargetId)
  if (targetId != null) return <DocumentViewer id={targetId} />
  return <DocumentsList />
}

function DocumentsList() {
  const navigateToDocument = useUIStore(s => s.navigateToDocument)
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('live')
  const [sort, setSort] = useState<DocumentSort>('updated_at')
  const [page, setPage] = useState(1)
  const q = useDebounced(query, 250)

  const params = useMemo(
    () => ({
      q,
      categoryId,
      statuses: STATUS_FILTERS[statusFilter],
      sort,
      page,
      pageSize: PAGE_SIZE,
    }),
    [q, categoryId, statusFilter, sort, page]
  )
  const { data, isLoading, isFetching, error } = useDocuments(params)
  const categories = useDocumentCategories(false)

  // One request for every open thread on any document; counted per CODE
  // (threads anchor on the code, not a revision). Lives under ['flags', …],
  // so the SSE glue's invalidate refreshes it on any flag event.
  const docFlags = useQuery({
    queryKey: flagKeys.list('all_open', { entity_type: 'document' }),
    queryFn: () => listFlags('all_open', { entity_type: 'document' }),
  })
  const openThreads = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of docFlags.data ?? []) {
      if (f.entity_id) m.set(f.entity_id, (m.get(f.entity_id) ?? 0) + 1)
    }
    return m
  }, [docFlags.data])

  const columns = useMemo<ColumnDef<DocumentRow>[]>(
    () => [
      {
        accessorKey: 'code',
        header: 'Code',
        size: 110,
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.code}</span>
        ),
      },
      {
        accessorKey: 'title',
        header: 'Title',
        size: 380,
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.original.title}</div>
            {row.original.description && (
              <div className="truncate text-xs text-muted-foreground">
                {row.original.description}
              </div>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'category_name',
        header: 'Category',
        size: 110,
        cell: ({ row }) => (
          <Badge variant="outline">{row.original.category_name}</Badge>
        ),
      },
      {
        accessorKey: 'revision',
        header: 'Rev',
        size: 60,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.revision}
            {row.original.revision_count > 1 && (
              <span className="text-muted-foreground">
                {' '}
                / {row.original.revision_count}
              </span>
            )}
          </span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        size: 90,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        accessorKey: 'effective_date',
        header: 'Effective',
        size: 100,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatDocDate(row.original.effective_date)}
          </span>
        ),
      },
      {
        accessorKey: 'author',
        header: 'Author',
        size: 140,
        cell: ({ row }) => (
          <span className="truncate text-muted-foreground">
            {row.original.author ?? '—'}
            {row.original.co_author ? ` + ${row.original.co_author}` : ''}
          </span>
        ),
      },
      {
        id: 'threads',
        header: 'Threads',
        size: 80,
        enableSorting: false,
        cell: ({ row }) => {
          const n = openThreads.get(row.original.code) ?? 0
          if (n === 0) return null
          return (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium hover:bg-muted"
              aria-label={`${n} open thread${n === 1 ? '' : 's'} on ${row.original.code}`}
              onClick={e => {
                e.stopPropagation()
                useUIStore
                  .getState()
                  .openFlagsForEntity('document', row.original.code)
              }}
            >
              <MessageSquare className="h-3 w-3" />
              {n}
            </button>
          )
        },
      },
      {
        accessorKey: 'updated_at',
        header: 'Updated',
        size: 100,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatDocDate(row.original.updated_at)}
          </span>
        ),
      },
      {
        accessorKey: 'created_at',
        header: 'Created',
        size: 100,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatDocDate(row.original.created_at)}
          </span>
        ),
      },
    ],
    [openThreads]
  )

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Documents</h1>
          <p className="text-sm text-muted-foreground">
            Artifacts, SOPs and other controlled documents published to the lab.
          </p>
        </div>
        {isFetching && !isLoading && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="documents-search"
          placeholder="Search code, title or description…"
          value={query}
          onChange={e => {
            setQuery(e.target.value)
            setPage(1)
          }}
          className="h-8 max-w-sm text-xs"
        />
        <Select
          value={categoryId == null ? 'all' : String(categoryId)}
          onValueChange={v => {
            setCategoryId(v === 'all' ? null : Number(v))
            setPage(1)
          }}
        >
          <SelectTrigger
            id="documents-category"
            className="h-8 w-[160px] text-xs"
          >
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {(categories.data ?? []).map(c => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={v => {
            setStatusFilter(v as StatusFilter)
            setPage(1)
          }}
        >
          <SelectTrigger
            id="documents-status"
            className="h-8 w-[150px] text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="live">Draft + Active</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="retired">Retired</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={sort}
          onValueChange={v => {
            setSort(v as DocumentSort)
            setPage(1)
          }}
        >
          <SelectTrigger id="documents-sort" className="h-8 w-[150px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updated_at">Recently updated</SelectItem>
            <SelectItem value="title">Title</SelectItem>
            <SelectItem value="code">Code</SelectItem>
            <SelectItem value="effective_date">Effective date</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {total} document{total === 1 ? '' : 's'}
        </span>
      </div>

      {error ? (
        <p className="text-sm text-destructive">
          Could not load documents: {error.message}
        </p>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
          <FileText className="h-8 w-8" />
          <p className="text-sm">No documents match.</p>
          <p className="max-w-md text-xs">
            Documents are published by agents with the{' '}
            <span className="font-mono">mk1-publish-document</span> skill. Clear
            the search or widen the status filter to see more.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <DataTable
            columns={columns}
            data={items}
            onRowClick={row => navigateToDocument(row.id)}
            getRowId={row => String(row.id)}
          />
        </div>
      )}

      {!error && items.length > 0 && pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            Previous
          </Button>
          <span className="tabular-nums">
            Page {page} of {pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage(p => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
