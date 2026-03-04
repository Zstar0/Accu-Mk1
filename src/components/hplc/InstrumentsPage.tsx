import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  Search,
  RefreshCw,
  Wrench,
  ChevronRight,
  X,
} from 'lucide-react'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import {
  getInstruments,
  syncInstruments,
  getMethods,
  type Instrument,
  type HplcMethod,
} from '@/lib/api'

export function InstrumentsPage() {
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [methods, setMethods] = useState<HplcMethod[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [instData, methodData] = await Promise.all([
        getInstruments(),
        getMethods(),
      ])
      setInstruments(instData)
      setMethods(methodData)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load instruments')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleSync = async () => {
    setSyncing(true)
    setError(null)
    try {
      const res = await syncInstruments()
      toast.success(`Instruments synced — ${res.created} new, ${res.total} total`)
      await load()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed'
      setError(msg)
      toast.error(msg)
    } finally {
      setSyncing(false)
    }
  }

  const selectedInstrument = instruments.find(i => i.id === selectedId) ?? null

  const filtered = instruments.filter(i => {
    if (!searchInput) return true
    const q = searchInput.toLowerCase()
    return (
      i.name.toLowerCase().includes(q) ||
      (i.senaite_id?.toLowerCase().includes(q) ?? false) ||
      (i.model?.toLowerCase().includes(q) ?? false) ||
      (i.brand?.toLowerCase().includes(q) ?? false) ||
      (i.instrument_type?.toLowerCase().includes(q) ?? false)
    )
  })

  const methodCountFor = (instrumentId: number) =>
    methods.filter(m => m.instrument_id === instrumentId).length

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Wrench className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Instruments</h1>
            <p className="text-sm text-muted-foreground">
              Lab instruments synced from Senaite LIMS
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={handleSync}
          disabled={syncing}
        >
          {syncing ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-4 w-4" />
          )}
          {syncing ? 'Syncing...' : 'Sync from Senaite'}
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

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search instruments..."
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Table */}
      <Card className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Instrument</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Brand</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Methods</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-12.5"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {instruments.length === 0
                    ? 'No instruments yet. Click "Sync from Senaite" to pull instruments.'
                    : 'No instruments match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(inst => (
                <TableRow
                  key={inst.id}
                  className={`cursor-pointer transition-colors hover:bg-muted/50 ${
                    selectedId === inst.id ? 'bg-muted/50' : ''
                  }`}
                  onClick={() => setSelectedId(inst.id)}
                >
                  <TableCell>
                    <div>
                      <div className="font-medium">{inst.name}</div>
                      {inst.senaite_id && (
                        <div className="text-xs text-muted-foreground">{inst.senaite_id}</div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{inst.instrument_type ?? '—'}</TableCell>
                  <TableCell>{inst.brand ?? '—'}</TableCell>
                  <TableCell>{inst.model ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{methodCountFor(inst.id)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={inst.active ? 'default' : 'outline'} className="text-xs">
                      {inst.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Right slide-out panel */}
      {selectedInstrument && (
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
                <Wrench className="h-5 w-5 text-primary" />
                <span className="text-lg font-semibold">{selectedInstrument.name}</span>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setSelectedId(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <InstrumentPanel
                instrument={selectedInstrument}
                methods={methods.filter(m => m.instrument_id === selectedInstrument.id)}
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

// ─── Instrument Detail Panel ───

function InstrumentPanel({
  instrument,
  methods,
}: {
  instrument: Instrument
  methods: HplcMethod[]
}) {
  return (
    <div className="space-y-6">
      {/* Detail grid */}
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <DetailRow label="Name" value={instrument.name} />
          <DetailRow label="Senaite ID" value={instrument.senaite_id} />
          <DetailRow label="Type" value={instrument.instrument_type} />
          <DetailRow label="Brand" value={instrument.brand} />
          <DetailRow label="Model" value={instrument.model} />
          <DetailRow
            label="Status"
            value={instrument.active ? 'Active' : 'Inactive'}
          />
        </div>
        {instrument.senaite_uid && (
          <div className="text-xs text-muted-foreground">
            Senaite UID: <span className="font-mono">{instrument.senaite_uid}</span>
          </div>
        )}
      </div>

      {/* Linked methods */}
      <div className="border-t pt-4">
        <h4 className="mb-3 text-sm font-semibold text-muted-foreground">
          Methods ({methods.length})
        </h4>
        {methods.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No methods linked to this instrument.
          </p>
        ) : (
          <div className="space-y-2">
            {methods.map(m => (
              <div
                key={m.id}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <div>
                  <span className="font-medium">{m.name}</span>
                  {m.senaite_id && (
                    <span className="ml-2 text-xs text-muted-foreground">{m.senaite_id}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {m.size_peptide && <span>{m.size_peptide}</span>}
                  <Badge variant="secondary" className="text-xs">
                    {m.common_peptides.length} peptide{m.common_peptides.length !== 1 ? 's' : ''}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Timestamps */}
      <div className="border-t pt-4 text-xs text-muted-foreground space-y-1">
        <div>Created: {new Date(instrument.created_at).toLocaleString()}</div>
        <div>Updated: {new Date(instrument.updated_at).toLocaleString()}</div>
      </div>
    </div>
  )
}

function DetailRow({
  label,
  value,
}: {
  label: string
  value: string | null | undefined
}) {
  return (
    <div>
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value ?? <span className="text-muted-foreground">—</span>}</dd>
    </div>
  )
}
