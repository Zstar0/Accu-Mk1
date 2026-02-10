/**
 * SharePoint Folder Browser
 *
 * A tree-style browser that lets users navigate SharePoint folders
 * and select a sample folder for HPLC analysis. Replaces the
 * drag-and-drop local file picker.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Folder,
  FileText,
  ChevronRight,
  Loader2,
  AlertCircle,
  RefreshCw,
  Cloud,
  CheckCircle2,
  ArrowLeft,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  browseSharePoint,
  type SharePointItem,
} from '@/lib/api'

interface SharePointBrowserProps {
  /** Called when user selects a folder for analysis */
  onFolderSelected: (path: string, folderName: string, files: SharePointItem[]) => void
  /** Whether the browser is in a loading/disabled state */
  disabled?: boolean
}

interface BreadcrumbSegment {
  label: string
  path: string
}

type SortField = 'name' | 'size' | 'created' | 'last_modified'
type SortDir = 'asc' | 'desc'

export function SharePointBrowser({ onFolderSelected, disabled }: SharePointBrowserProps) {
  const [currentPath, setCurrentPath] = useState('')
  const [items, setItems] = useState<SharePointItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  // Build breadcrumbs from current path
  const breadcrumbs: BreadcrumbSegment[] = [
    { label: 'LIMS CSVs', path: '' },
  ]
  if (currentPath) {
    const parts = currentPath.split('/')
    let accumulated = ''
    for (const part of parts) {
      accumulated = accumulated ? `${accumulated}/${part}` : part
      breadcrumbs.push({ label: part, path: accumulated })
    }
  }

  // Sort items — folders first, then by selected column
  const sortedItems = useMemo(() => {
    const folders = items.filter(i => i.type === 'folder')
    const files = items.filter(i => i.type === 'file')

    const compare = (a: SharePointItem, b: SharePointItem): number => {
      let cmp = 0
      switch (sortField) {
        case 'name':
          cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
          break
        case 'size':
          cmp = a.size - b.size
          break
        case 'created':
          cmp = (a.created ?? '').localeCompare(b.created ?? '')
          break
        case 'last_modified':
          cmp = (a.last_modified ?? '').localeCompare(b.last_modified ?? '')
          break
      }
      return sortDir === 'desc' ? -cmp : cmp
    }

    folders.sort(compare)
    files.sort(compare)
    return { folders, files }
  }, [items, sortField, sortDir])

  // Load folder contents
  const loadFolder = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await browseSharePoint(path, 'lims')
      setItems(result.items)
      setCurrentPath(path)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load folder')
    } finally {
      setLoading(false)
    }
  }, [])

  // Load root on mount
  useEffect(() => {
    loadFolder('')
  }, [loadFolder])

  // Navigate into a folder
  const openFolder = (folderName: string) => {
    const newPath = currentPath ? `${currentPath}/${folderName}` : folderName
    loadFolder(newPath)
  }

  // Navigate to a breadcrumb
  const goToBreadcrumb = (path: string) => {
    loadFolder(path)
  }

  // Toggle sort
  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(field === 'name' ? 'asc' : 'desc') // dates/size default to newest/largest first
    }
  }

  // Select current folder for analysis
  const selectCurrentFolder = () => {
    const folderName = currentPath.split('/').pop() || 'LIMS CSVs'
    onFolderSelected(currentPath, folderName, items)
  }

  // Check if current folder has CSV files (eligible for selection)
  const csvFiles = items.filter(
    i => i.type === 'file' && i.name.toLowerCase().endsWith('.csv')
  )
  const hasCSVs = csvFiles.length > 0

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const formatDate = (iso: string | null) => {
    if (!iso) return '—'
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 opacity-30" />
    return sortDir === 'asc'
      ? <ArrowUp className="h-3 w-3" />
      : <ArrowDown className="h-3 w-3" />
  }

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cloud className="h-5 w-5 text-blue-500" />
            <CardTitle className="text-base">SharePoint — LIMS CSVs</CardTitle>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => loadFolder(currentPath)}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <CardDescription>
          Browse and select a sample folder for analysis
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Breadcrumb navigation */}
        <div className="flex items-center gap-1 mb-3 text-sm flex-wrap">
          {breadcrumbs.map((bc, i) => (
            <span key={bc.path} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
              <button
                onClick={() => goToBreadcrumb(bc.path)}
                className={`hover:underline ${
                  i === breadcrumbs.length - 1
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground'
                }`}
                disabled={loading || disabled}
              >
                {bc.label}
              </button>
            </span>
          ))}
        </div>

        {/* Error state */}
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm mb-3">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => loadFolder(currentPath)}
            >
              Retry
            </Button>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading...
          </div>
        )}

        {/* File listing */}
        {!loading && !error && (
          <>
            {/* Column headers */}
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground border-b mb-1">
              <button
                className="flex items-center gap-1 flex-1 hover:text-foreground transition-colors"
                onClick={() => toggleSort('name')}
              >
                Name <SortIcon field="name" />
              </button>
              <button
                className="flex items-center gap-1 w-16 justify-end hover:text-foreground transition-colors"
                onClick={() => toggleSort('size')}
              >
                Size <SortIcon field="size" />
              </button>
              <button
                className="flex items-center gap-1 w-24 justify-end hover:text-foreground transition-colors"
                onClick={() => toggleSort('created')}
              >
                Created <SortIcon field="created" />
              </button>
              <button
                className="flex items-center gap-1 w-24 justify-end hover:text-foreground transition-colors"
                onClick={() => toggleSort('last_modified')}
              >
                Modified <SortIcon field="last_modified" />
              </button>
            </div>

            <ScrollArea className="h-[320px]">
              <div className="space-y-0.5">
                {/* Back button when not at root */}
                {currentPath && (
                  <button
                    onClick={() => {
                      const parent = currentPath.split('/').slice(0, -1).join('/')
                      loadFolder(parent)
                    }}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded hover:bg-accent text-sm text-muted-foreground"
                    disabled={disabled}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    <span>Back</span>
                  </button>
                )}

                {/* Folders first */}
                {sortedItems.folders.map(item => (
                  <button
                    key={item.id}
                    onClick={() => openFolder(item.name)}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded hover:bg-accent text-sm group"
                    disabled={disabled}
                  >
                    <Folder className="h-4 w-4 text-amber-500 shrink-0" />
                    <span className="truncate text-left flex-1">{item.name}</span>
                    {item.child_count != null && (
                      <span className="text-muted-foreground text-xs w-16 text-right">
                        {item.child_count} items
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground w-24 text-right">
                      {formatDate(item.created)}
                    </span>
                    <span className="text-xs text-muted-foreground w-24 text-right">
                      {formatDate(item.last_modified)}
                    </span>
                    <ChevronRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
                  </button>
                ))}

                {/* Files */}
                {sortedItems.files.map(item => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
                  >
                    <FileText className="h-4 w-4 shrink-0" />
                    <span className="truncate flex-1">{item.name}</span>
                    <span className="text-xs w-16 text-right">{formatSize(item.size)}</span>
                    <span className="text-xs w-24 text-right">{formatDate(item.created)}</span>
                    <span className="text-xs w-24 text-right">{formatDate(item.last_modified)}</span>
                  </div>
                ))}

                {/* Empty state */}
                {items.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    This folder is empty
                  </div>
                )}
              </div>
            </ScrollArea>
          </>
        )}

        {/* Selection action */}
        {hasCSVs && !loading && (
          <div className="mt-3 pt-3 border-t flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              <Badge variant="secondary" className="mr-2">
                {csvFiles.length} CSV{csvFiles.length !== 1 ? 's' : ''}
              </Badge>
              found in this folder
            </div>
            <Button
              size="sm"
              onClick={selectCurrentFolder}
              disabled={disabled}
            >
              <CheckCircle2 className="h-4 w-4 mr-1" />
              Use this folder
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
