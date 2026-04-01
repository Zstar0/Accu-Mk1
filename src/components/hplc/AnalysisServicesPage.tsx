import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  Search,
  RefreshCw,
  FlaskConical,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  getAnalysisServices,
  syncAnalysisServices,
  updateAnalysisServicePeptide,
  getPeptides,
  type AnalysisServiceRecord,
  type PeptideRecord,
} from '@/lib/api'

export function AnalysisServicesPage() {
  const [services, setServices] = useState<AnalysisServiceRecord[]>([])
  const [peptides, setPeptides] = useState<PeptideRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [svcData, pepData] = await Promise.all([
        getAnalysisServices(),
        getPeptides(),
      ])
      setServices(svcData)
      setPeptides(pepData)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analysis services')
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
      const res = await syncAnalysisServices()
      toast.success(`Analysis services synced — ${res.created} new, ${res.total} total`)
      await load()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed'
      setError(msg)
      toast.error(msg)
    } finally {
      setSyncing(false)
    }
  }

  const selectedService = services.find(s => s.id === selectedId) ?? null

  const filtered = services.filter(s => {
    if (!searchInput) return true
    const q = searchInput.toLowerCase()
    return (
      s.title.toLowerCase().includes(q) ||
      (s.keyword?.toLowerCase().includes(q) ?? false) ||
      (s.category?.toLowerCase().includes(q) ?? false) ||
      (s.peptide_name?.toLowerCase().includes(q) ?? false) ||
      (s.unit?.toLowerCase().includes(q) ?? false)
    )
  })

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FlaskConical className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Analysis Services</h1>
            <p className="text-sm text-muted-foreground">
              Lab tests synced from Senaite LIMS
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
          placeholder="Search services..."
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
              <TableHead>Service</TableHead>
              <TableHead>Peptide Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Unit</TableHead>
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
                  {services.length === 0
                    ? 'No analysis services yet. Click "Sync from Senaite" to pull services.'
                    : 'No services match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(svc => (
                <TableRow
                  key={svc.id}
                  className={`cursor-pointer transition-colors hover:bg-muted/50 ${
                    selectedId === svc.id ? 'bg-muted/50' : ''
                  }`}
                  onClick={() => setSelectedId(svc.id)}
                >
                  <TableCell>
                    <div>
                      <div className="font-medium">{svc.title}</div>
                      {svc.keyword && (
                        <div className="text-xs text-muted-foreground">{svc.keyword}</div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{svc.peptide_name ?? '—'}</TableCell>
                  <TableCell>{svc.category ?? '—'}</TableCell>
                  <TableCell>{svc.unit ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{svc.methods?.length ?? 0}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={svc.active ? 'default' : 'outline'} className="text-xs">
                      {svc.active ? 'Active' : 'Inactive'}
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
      {selectedService && (
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
                <FlaskConical className="h-5 w-5 text-primary" />
                <span className="text-lg font-semibold">{selectedService.title}</span>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setSelectedId(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <ServicePanel
                service={selectedService}
                peptides={peptides}
                onPeptideChange={async (peptideId) => {
                  try {
                    await updateAnalysisServicePeptide(selectedService.id, peptideId)
                    toast.success(peptideId ? 'Peptide linked' : 'Peptide unlinked')
                    await load()
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : 'Failed to update peptide link')
                  }
                }}
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

// ─── Service Detail Panel ───

function ServicePanel({
  service,
  peptides,
  onPeptideChange,
}: {
  service: AnalysisServiceRecord
  peptides: PeptideRecord[]
  onPeptideChange: (peptideId: number | null) => void
}) {
  const isSlotService = /^ANALYTE-\d/i.test(service.keyword ?? '')

  return (
    <div className="space-y-6">
      {/* Detail grid */}
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <DetailRow label="Title" value={service.title} />
          <DetailRow label="Keyword" value={service.keyword} />
          <div className="col-span-2">
            <dt className="font-medium text-muted-foreground mb-1">Linked Peptide</dt>
            {isSlotService ? (
              <dd className="text-xs text-muted-foreground italic">
                Generic slot service — peptide resolved per-sample from SENAITE Analyte fields
              </dd>
            ) : (
              <Select
                value={service.peptide_id != null ? String(service.peptide_id) : 'none'}
                onValueChange={value =>
                  onPeptideChange(value === 'none' ? null : Number(value))
                }
              >
                <SelectTrigger className="w-full max-w-xs">
                  <SelectValue placeholder="Select peptide…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {peptides
                    .filter(p => p.active)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(p => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name}{p.is_blend ? ' (blend)' : ''}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <DetailRow label="Category" value={service.category} />
          <DetailRow label="Unit" value={service.unit} />
          <DetailRow
            label="Status"
            value={service.active ? 'Active' : 'Inactive'}
          />
        </div>
        {service.senaite_uid && (
          <div className="text-xs text-muted-foreground">
            Senaite UID: <span className="font-mono">{service.senaite_uid}</span>
          </div>
        )}
        {service.senaite_id && (
          <div className="text-xs text-muted-foreground">
            Senaite ID: <span className="font-mono">{service.senaite_id}</span>
          </div>
        )}
      </div>

      {/* Methods */}
      <div className="border-t pt-4">
        <h4 className="mb-3 text-sm font-semibold text-muted-foreground">
          Methods ({service.methods?.length ?? 0})
        </h4>
        {!service.methods || service.methods.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No methods linked to this service.
          </p>
        ) : (
          <div className="space-y-2">
            {service.methods.map((m, i) => (
              <div
                key={m.uid || i}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <span className="font-medium">{m.title}</span>
                <span className="text-xs text-muted-foreground font-mono">{m.uid.slice(0, 8)}...</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Timestamps */}
      <div className="border-t pt-4 text-xs text-muted-foreground space-y-1">
        <div>Created: {new Date(service.created_at).toLocaleString()}</div>
        <div>Updated: {new Date(service.updated_at).toLocaleString()}</div>
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
