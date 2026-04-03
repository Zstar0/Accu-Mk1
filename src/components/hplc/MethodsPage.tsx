import { useState, useEffect, useCallback } from 'react'
import {
  Plus,
  Trash2,
  ChevronRight,
  Loader2,
  AlertCircle,
  X,
  Beaker,
  Search,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { MethodPanel } from './MethodPanel'
import { useUIStore } from '@/store/ui-store'
import {
  getMethods,
  createMethod,
  deleteMethod,
  updateMethod,
  getInstruments,
  type HplcMethod,
  type Instrument,
} from '@/lib/api'

const INSTRUMENT_COLORS = new Map<number, string>()
const COLOR_PALETTE = [
  'bg-blue-500/15 text-blue-400 border-blue-500/30',
  'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  'bg-amber-500/15 text-amber-400 border-amber-500/30',
  'bg-purple-500/15 text-purple-400 border-purple-500/30',
  'bg-rose-500/15 text-rose-400 border-rose-500/30',
  'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
]
function instrumentColor(id: number): string {
  if (!INSTRUMENT_COLORS.has(id)) {
    INSTRUMENT_COLORS.set(id, COLOR_PALETTE[INSTRUMENT_COLORS.size % COLOR_PALETTE.length]!)
  }
  return INSTRUMENT_COLORS.get(id)!
}

export function MethodsPage() {
  const [methods, setMethods] = useState<HplcMethod[]>([])
  const [allInstruments, setAllInstruments] = useState<Instrument[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [selectedMethodIds, setSelectedMethodIds] = useState<Set<number>>(new Set())
  const [bulkAssigning, setBulkAssigning] = useState(false)
  const [instrumentTab, setInstrumentTab] = useState<string>('all')

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<HplcMethod | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getMethods()
      setMethods(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load methods')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    getInstruments().then(setAllInstruments).catch(console.error)
  }, [load])

  // Handle target navigation (e.g. from peptide page "View Method" link)
  useEffect(() => {
    const targetId = useUIStore.getState().methodsTargetId
    if (targetId && methods.length > 0) {
      const match = methods.find(m => m.id === targetId)
      if (match) setSelectedId(targetId)
      useUIStore.setState({ methodsTargetId: null })
    }
  }, [methods])

  const selectedMethod = methods.find(m => m.id === selectedId) ?? null

  // Find the active instrument by ID (tab stores instrument ID as string, or 'all')
  const activeInstrumentId = instrumentTab === 'all' ? null : Number(instrumentTab)

  // Client-side filtering: instrument tab + search
  const filtered = methods.filter(m => {
    // Instrument tab filter — "all" shows everything, otherwise match by instrument ID
    if (activeInstrumentId != null && !m.instrument_ids.includes(activeInstrumentId)) return false
    // Text search
    if (!searchInput) return true
    const q = searchInput.toLowerCase()
    return (
      m.name.toLowerCase().includes(q) ||
      (m.senaite_id?.toLowerCase().includes(q) ?? false) ||
      m.instruments.some(i => i.name.toLowerCase().includes(q)) ||
      (m.size_peptide?.toLowerCase().includes(q) ?? false) ||
      (m.dissolution?.toLowerCase().includes(q) ?? false)
    )
  })

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteMethod(deleteTarget.id)
      if (selectedId === deleteTarget.id) setSelectedId(null)
      setDeleteTarget(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete method')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Beaker className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">HPLC Methods</h1>
            <p className="text-sm text-muted-foreground">
              Manage analytical methods and their instrument settings
            </p>
          </div>
        </div>
        <Button onClick={() => setShowAddForm(true)} disabled={showAddForm}>
          <Plus className="mr-1 h-4 w-4" />
          New Method
        </Button>
      </div>

      {/* Error */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 py-3">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <span className="text-sm text-destructive">{error}</span>
          </CardContent>
        </Card>
      )}

      {/* Add form */}
      {showAddForm && (
        <AddMethodForm
          onSaved={() => {
            setShowAddForm(false)
            load()
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* Search + Instrument tabs */}
      <div className="flex items-center justify-between">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search methods..."
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-0 border-b border-zinc-800">
          <span className="text-xs font-medium text-muted-foreground mr-3 uppercase tracking-wider">Filter</span>
          <button
            type="button"
            onClick={() => setInstrumentTab('all')}
            className={`relative px-4 py-2 text-sm font-medium transition-colors ${
              instrumentTab === 'all'
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground/80'
            }`}
          >
            All
            {instrumentTab === 'all' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />
            )}
          </button>
          {allInstruments.map(inst => {
            const isActive = instrumentTab === String(inst.id)
            return (
              <button
                key={inst.id}
                type="button"
                onClick={() => setInstrumentTab(String(inst.id))}
                className={`relative px-4 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground/80'
                }`}
              >
                {inst.name}
                {isActive && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedMethodIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-2">
          <span className="text-sm font-medium">{selectedMethodIds.size} selected</span>
          <span className="text-sm text-muted-foreground">Assign to:</span>
          {allInstruments.map(inst => (
            <Button
              key={inst.id}
              variant="outline"
              size="sm"
              disabled={bulkAssigning}
              onClick={async () => {
                setBulkAssigning(true)
                try {
                  const targets = methods.filter(m => selectedMethodIds.has(m.id))
                  await Promise.all(
                    targets.map(m => {
                      if (m.instrument_ids.includes(inst.id)) return Promise.resolve()
                      return updateMethod(m.id, { instrument_ids: [...m.instrument_ids, inst.id] })
                    })
                  )
                  setSelectedMethodIds(new Set())
                  await load()
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Bulk assign failed')
                } finally {
                  setBulkAssigning(false)
                }
              }}
            >
              {inst.name}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedMethodIds(new Set())}
            className="ml-auto"
          >
            Clear
          </Button>
        </div>
      )}

      {/* Table */}
      <Card className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                <Checkbox
                  checked={filtered.length > 0 && filtered.every(m => selectedMethodIds.has(m.id))
                    ? true
                    : filtered.some(m => selectedMethodIds.has(m.id))
                      ? 'indeterminate'
                      : false}
                  onCheckedChange={checked => {
                    if (checked) {
                      setSelectedMethodIds(new Set(filtered.map(m => m.id)))
                    } else {
                      setSelectedMethodIds(new Set())
                    }
                  }}
                />
              </TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Instruments</TableHead>
              <TableHead>Size Peptide</TableHead>
              <TableHead>Organic %</TableHead>
              <TableHead>Dissolution</TableHead>
              <TableHead>Peptides</TableHead>
              <TableHead className="w-[80px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  {methods.length === 0
                    ? 'No methods yet. Click "New Method" to create one.'
                    : 'No methods match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(m => (
                <TableRow
                  key={m.id}
                  className={`cursor-pointer transition-colors hover:bg-muted/50 ${
                    selectedId === m.id ? 'bg-muted/50' : ''
                  }`}
                  onClick={() => setSelectedId(m.id)}
                >
                  <TableCell onClick={e => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedMethodIds.has(m.id)}
                      onCheckedChange={checked => {
                        setSelectedMethodIds(prev => {
                          const next = new Set(prev)
                          if (checked) next.add(m.id)
                          else next.delete(m.id)
                          return next
                        })
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <div>
                      <div className="font-medium">{m.name}</div>
                      {m.senaite_id && (
                        <div className="text-xs text-muted-foreground">{m.senaite_id}</div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {m.instruments.length > 0 ? m.instruments.map(i => (
                        <span key={i.id} className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${instrumentColor(i.id)}`}>
                          {i.name}
                        </span>
                      )) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {m.size_peptide ? (
                      <span className="text-sm">{m.size_peptide}</span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    {m.starting_organic_pct != null ? `${m.starting_organic_pct}%` : '—'}
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{m.dissolution ?? '—'}</span>
                  </TableCell>
                  <TableCell>
                    {m.common_peptides.length > 0 ? (
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="secondary" className="cursor-default">
                              {m.common_peptides.length}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent side="left" className="max-w-xs">
                            <div className="space-y-1">
                              {m.common_peptides.map(p => (
                                <div key={p.id} className="text-xs">
                                  <span className="font-medium">{p.abbreviation}</span>
                                  <span className="text-muted-foreground ml-1">({p.name})</span>
                                </div>
                              ))}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <Badge variant="secondary" className="opacity-50">0</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={e => {
                          e.stopPropagation()
                          setDeleteTarget(m)
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Delete Method</CardTitle>
              <CardDescription>
                Are you sure you want to delete <strong>{deleteTarget.name}</strong>?
                {deleteTarget.common_peptides.length > 0 && (
                  <span className="mt-1 block text-amber-600">
                    {deleteTarget.common_peptides.length} peptide(s) will have their method
                    unassigned.
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Delete
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Right slide-out panel */}
      {selectedMethod && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]"
            style={{ animation: 'fadeIn 0.2s ease-out' }}
            onClick={() => setSelectedId(null)}
          />
          <div
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l bg-background shadow-xl"
            style={{ animation: 'slideInRight 0.25s ease-out' }}
          >
            {/* Sticky header */}
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-6 py-4">
              <div className="flex items-center gap-2">
                <Beaker className="h-5 w-5 text-primary" />
                <span className="text-lg font-semibold">{selectedMethod.name}</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSelectedId(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <MethodPanel
                key={selectedMethod.id}
                method={selectedMethod}
                onUpdated={load}
              />
            </div>
          </div>
        </>
      )}

      {/* Animations */}
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>
    </div>
  )
}

// ─── Inline Add Method Form ───

function AddMethodForm({
  onSaved,
  onCancel,
}: {
  onSaved: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [senaiteId, setSenaiteId] = useState('')
  const [instrumentId, setInstrumentId] = useState<number | null>(null)
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getInstruments().then(setInstruments).catch(console.error)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await createMethod({
        name: name.trim(),
        senaite_id: senaiteId.trim() || null,
        instrument_ids: instrumentId ? [instrumentId] : [],
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create method')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">New Method</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Method 1"
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Senaite ID</Label>
              <Input
                value={senaiteId}
                onChange={e => setSenaiteId(e.target.value)}
                placeholder="MET-HPLC1-PURITY-1290A"
              />
            </div>
            <div className="space-y-2">
              <Label>Instrument</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={instrumentId ?? ''}
                onChange={e => setInstrumentId(e.target.value ? parseInt(e.target.value, 10) : null)}
              >
                <option value="">None</option>
                {instruments.map(inst => (
                  <option key={inst.id} value={inst.id}>{inst.name}</option>
                ))}
              </select>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Create
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
