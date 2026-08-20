import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  Search,
  Wrench,
  ChevronRight,
  X,
  Plus,
  Save,
  Pencil,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  getInstruments,
  getMethods,
  createInstrument,
  updateInstrument,
  getDepartments,
  type Instrument,
  type HplcMethod,
  type Department,
} from '@/lib/api'

export function InstrumentsPage() {
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [methods, setMethods] = useState<HplcMethod[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)

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
    methods.filter(m => m.instrument_ids.includes(instrumentId)).length

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Wrench className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Instruments</h1>
            <p className="text-sm text-muted-foreground">
              Lab instruments — register and manage locally
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setShowAddForm(true)} disabled={showAddForm}>
            <Plus className="mr-1 h-4 w-4" />
            Add Instrument
          </Button>
        </div>
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
        <AddInstrumentForm
          onSaved={() => {
            setShowAddForm(false)
            load()
          }}
          onCancel={() => setShowAddForm(false)}
        />
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
                    ? 'No instruments yet. Click “Add Instrument” to register one.'
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
                key={selectedInstrument.id}
                instrument={selectedInstrument}
                methods={methods.filter(m => m.instrument_ids.includes(selectedInstrument.id))}
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

// ─── Instrument Detail Panel ───

function InstrumentPanel({
  instrument,
  methods,
  onUpdated,
}: {
  instrument: Instrument
  methods: HplcMethod[]
  onUpdated: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [departments, setDepartments] = useState<Department[]>([])

  useEffect(() => {
    getDepartments().then(setDepartments).catch(console.error)
  }, [])

  // Editable fields
  const [name, setName] = useState(instrument.name)
  const [instrumentType, setInstrumentType] = useState(instrument.instrument_type ?? '')
  const [brand, setBrand] = useState(instrument.brand ?? '')
  const [model, setModel] = useState(instrument.model ?? '')
  const [departmentId, setDepartmentId] = useState<number | null>(instrument.department_id ?? null)
  const [active, setActive] = useState(instrument.active)

  const resetForm = () => {
    setName(instrument.name)
    setInstrumentType(instrument.instrument_type ?? '')
    setBrand(instrument.brand ?? '')
    setModel(instrument.model ?? '')
    setDepartmentId(instrument.department_id ?? null)
    setActive(instrument.active)
    setError(null)
  }

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await updateInstrument(instrument.id, {
        name: name.trim(),
        instrument_type: instrumentType.trim() || null,
        brand: brand.trim() || null,
        model: model.trim() || null,
        department_id: departmentId,
        active,
      })
      setEditing(false)
      onUpdated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    resetForm()
    setEditing(false)
  }

  return (
    <div className="space-y-6">
      {/* Header with edit/save controls */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{instrument.name}</h3>
          {instrument.senaite_id && (
            <p className="text-sm text-muted-foreground">{instrument.senaite_id}</p>
          )}
        </div>
        {editing ? (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={handleCancel} disabled={saving}>
              <X className="mr-1 h-3.5 w-3.5" />
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1 h-3.5 w-3.5" />
              )}
              Save
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="mr-1 h-3.5 w-3.5" />
            Edit
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Detail grid */}
      {editing ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="inst-edit-name">Name</Label>
            <Input
              id="inst-edit-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Agilent 1260 Infinity"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="inst-edit-type">Type</Label>
              <Input
                id="inst-edit-type"
                value={instrumentType}
                onChange={e => setInstrumentType(e.target.value)}
                placeholder="HPLC"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inst-edit-department">Department</Label>
              <select
                id="inst-edit-department"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={departmentId ?? ''}
                onChange={e => setDepartmentId(e.target.value ? parseInt(e.target.value, 10) : null)}
              >
                <option value="">None</option>
                {departments.map(dept => (
                  <option key={dept.id} value={dept.id}>{dept.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="inst-edit-brand">Brand</Label>
              <Input
                id="inst-edit-brand"
                value={brand}
                onChange={e => setBrand(e.target.value)}
                placeholder="Agilent"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inst-edit-model">Model</Label>
              <Input
                id="inst-edit-model"
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder="1260 Infinity"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={active}
              onCheckedChange={checked => setActive(checked === true)}
            />
            Active
          </label>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <DetailRow label="Type" value={instrument.instrument_type} />
            <DetailRow label="Brand" value={instrument.brand} />
            <DetailRow label="Model" value={instrument.model} />
            <DetailRow
              label="Department"
              value={departments.find(d => d.id === instrument.department_id)?.name ?? null}
            />
            <DetailRow
              label="Status"
              value={instrument.active ? 'Active' : 'Inactive'}
            />
            <DetailRow
              label="Origin"
              value={instrument.origin === 'senaite' ? 'SENAITE (legacy)' : 'Mk1'}
            />
          </div>
          {instrument.senaite_uid && (
            <div className="text-xs text-muted-foreground">
              Senaite UID: <span className="font-mono">{instrument.senaite_uid}</span>
            </div>
          )}
        </div>
      )}

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

// ─── Inline Add Instrument Form ───

function AddInstrumentForm({
  onSaved,
  onCancel,
}: {
  onSaved: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [instrumentType, setInstrumentType] = useState('')
  const [brand, setBrand] = useState('')
  const [model, setModel] = useState('')
  const [departmentId, setDepartmentId] = useState<number | null>(null)
  const [departments, setDepartments] = useState<Department[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getDepartments().then(setDepartments).catch(console.error)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await createInstrument({
        name: name.trim(),
        instrument_type: instrumentType.trim() || null,
        brand: brand.trim() || null,
        model: model.trim() || null,
        department_id: departmentId,
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create instrument')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">New Instrument</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="new-instrument-name">Name *</Label>
              <Input
                id="new-instrument-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Agilent 1260 Infinity"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-instrument-type">Type</Label>
              <Input
                id="new-instrument-type"
                value={instrumentType}
                onChange={e => setInstrumentType(e.target.value)}
                placeholder="HPLC"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-instrument-brand">Brand</Label>
              <Input
                id="new-instrument-brand"
                value={brand}
                onChange={e => setBrand(e.target.value)}
                placeholder="Agilent"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-instrument-model">Model</Label>
              <Input
                id="new-instrument-model"
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder="1260 Infinity"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-instrument-department">Department</Label>
              <select
                id="new-instrument-department"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={departmentId ?? ''}
                onChange={e => setDepartmentId(e.target.value ? parseInt(e.target.value, 10) : null)}
              >
                <option value="">None</option>
                {departments.map(dept => (
                  <option key={dept.id} value={dept.id}>{dept.name}</option>
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
