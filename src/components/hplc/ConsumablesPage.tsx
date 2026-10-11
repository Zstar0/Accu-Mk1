import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  Search,
  Package,
  ChevronRight,
  X,
  Plus,
  Save,
  Lock,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  createConsumable,
  getInstruments,
  listConsumableKinds,
  listConsumables,
  updateConsumable,
  type ConsumableKind,
  type ConsumableType,
  type Instrument,
} from '@/lib/api'

// The native select the Instruments page uses for Department.
const SELECT =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60'

/**
 * The consumables catalog (spec 2026-10-10 3.1, 3.2, 6.4): the cartridges the
 * lab runs and, later, other kinds, built like the Instruments page. Which
 * numbers a type holds comes from the server's kind registry. A type's kind
 * and numbers lock once a worksheet has used it or an issued (not draft)
 * method revision links it; a wrong number is fixed by retiring the type and
 * adding a new one. Nothing is ever deleted.
 */
export function ConsumablesPage() {
  const [consumables, setConsumables] = useState<ConsumableType[]>([])
  const [kinds, setKinds] = useState<ConsumableKind[]>([])
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | 'new' | null>(null)
  const [searchInput, setSearchInput] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [rows, kindRows, instrumentRows] = await Promise.all([
        listConsumables(),
        listConsumableKinds(),
        getInstruments(),
      ])
      setConsumables(rows)
      setKinds(kindRows)
      setInstruments(instrumentRows)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load consumables'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const editing =
    typeof selected === 'number'
      ? (consumables.find(c => c.id === selected) ?? null)
      : null
  const panelOpen = selected === 'new' || editing !== null
  const kindLabel = (key: string) =>
    kinds.find(k => k.key === key)?.label ?? key
  // One column per number a kind defines (today: the cartridge's sensitivity).
  const specColumns = kinds.flatMap(k =>
    k.specs.map(s => ({ kind: k.key, ...s }))
  )
  const colCount = 8 + specColumns.length

  const filtered = consumables.filter(c => {
    if (!searchInput) return true
    const q = searchInput.toLowerCase()
    return [c.name, c.manufacturer, c.part_number, kindLabel(c.kind)].some(
      v => v?.toLowerCase().includes(q) ?? false
    )
  })

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Package className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Consumables</h1>
            <p className="text-sm text-muted-foreground">
              Cartridges and other supplies methods allow. Retire a type to stop
              offering it; nothing is deleted.
            </p>
          </div>
        </div>
        <Button
          onClick={() => setSelected('new')}
          disabled={kinds.length === 0}
        >
          <Plus className="mr-1 h-4 w-4" />
          Add consumable
        </Button>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 py-3">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <span className="text-sm text-destructive">{error}</span>
          </CardContent>
        </Card>
      )}

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search consumables..."
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          className="pl-9"
        />
      </div>

      <Card className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Manufacturer</TableHead>
              <TableHead>Part number</TableHead>
              <TableHead>Instrument</TableHead>
              {specColumns.map(col => (
                <TableHead
                  key={`${col.kind}.${col.key}`}
                  className="text-right"
                >
                  {col.label}
                  {col.unit && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {col.unit}
                    </span>
                  )}
                </TableHead>
              ))}
              <TableHead>In use</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-12.5"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={colCount} className="py-8 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={colCount}
                  className="py-8 text-center text-muted-foreground"
                >
                  {consumables.length === 0
                    ? 'No consumables yet. Click "Add consumable" to register one.'
                    : 'No consumables match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(c => (
                <TableRow
                  key={c.id}
                  className={`cursor-pointer transition-colors hover:bg-muted/50 ${
                    selected === c.id ? 'bg-muted/50' : ''
                  }`}
                  onClick={() => setSelected(c.id)}
                >
                  <TableCell>{kindLabel(c.kind)}</TableCell>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.manufacturer ?? '-'}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {c.part_number ?? '-'}
                  </TableCell>
                  <TableCell>
                    {instruments.find(i => i.id === c.instrument_id)?.name ??
                      '-'}
                  </TableCell>
                  {specColumns.map(col => (
                    <TableCell
                      key={`${col.kind}.${col.key}`}
                      className="text-right font-mono"
                    >
                      {c.kind === col.kind
                        ? String(c.specs[col.key] ?? '-')
                        : '-'}
                    </TableCell>
                  ))}
                  <TableCell>
                    <Badge
                      variant={c.in_use ? 'secondary' : 'outline'}
                      className="text-xs"
                    >
                      {c.in_use ? 'Yes' : 'No'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={c.active ? 'default' : 'outline'}
                      className="text-xs"
                    >
                      {c.active ? 'Active' : 'Retired'}
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

      {panelOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]"
            style={{ animation: 'fadeIn 0.2s ease-out' }}
            onClick={() => setSelected(null)}
          />
          <div
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l bg-background shadow-xl"
            style={{ animation: 'slideInRight 0.25s ease-out' }}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-6 py-4">
              <div className="flex items-center gap-2">
                <Package className="h-5 w-5 text-primary" />
                <span className="text-lg font-semibold">
                  {editing ? editing.name : 'New consumable'}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close"
                onClick={() => setSelected(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <ConsumablePanel
                key={String(selected)}
                consumable={editing}
                kinds={kinds}
                instruments={instruments}
                onSaved={() => {
                  setSelected(null)
                  load()
                }}
              />
            </div>
          </div>
        </>
      )}

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

// ─── Create / edit panel ───

function ConsumablePanel({
  consumable,
  kinds,
  instruments,
  onSaved,
}: {
  consumable: ConsumableType | null
  kinds: ConsumableKind[]
  instruments: Instrument[]
  onSaved: () => void
}) {
  const locked = consumable?.in_use ?? false
  const [kind, setKind] = useState(consumable?.kind ?? kinds[0]?.key ?? '')
  const [name, setName] = useState(consumable?.name ?? '')
  const [manufacturer, setManufacturer] = useState(
    consumable?.manufacturer ?? ''
  )
  const [partNumber, setPartNumber] = useState(consumable?.part_number ?? '')
  const [instrumentId, setInstrumentId] = useState<number | null>(
    consumable?.instrument_id ?? null
  )
  const [specs, setSpecs] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(consumable?.specs ?? {}).map(([k, v]) => [k, String(v)])
    )
  )
  const [active, setActive] = useState(consumable?.active ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kindDef = kinds.find(k => k.key === kind)

  async function handleSave() {
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    const numbers: Record<string, number> = {}
    if (!locked) {
      for (const s of kindDef?.specs ?? []) {
        const text = (specs[s.key] ?? '').trim()
        if (!text) {
          if (s.required) {
            setError(`${s.label} is required`)
            return
          }
          continue
        }
        const n = Number(text)
        if (!Number.isFinite(n) || n <= 0) {
          setError(`${s.label} must be a number above zero`)
          return
        }
        numbers[s.key] = n
      }
    }
    const fields = {
      name: name.trim(),
      manufacturer: manufacturer.trim() || null,
      part_number: partNumber.trim() || null,
      instrument_id: instrumentId,
    }
    setSaving(true)
    setError(null)
    try {
      if (!consumable) {
        await createConsumable({ kind, specs: numbers, ...fields })
      } else if (locked) {
        // A used type's kind and numbers are locked server-side (409): never send them.
        await updateConsumable(consumable.id, { ...fields, active })
      } else {
        await updateConsumable(consumable.id, {
          ...fields,
          kind,
          specs: numbers,
          active,
        })
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="cons-kind">Kind</Label>
        <select
          id="cons-kind"
          className={SELECT}
          value={kind}
          disabled={locked}
          onChange={e => setKind(e.target.value)}
        >
          {kinds.map(k => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="cons-name">Name</Label>
        <Input
          id="cons-name"
          value={name}
          maxLength={200}
          onChange={e => setName(e.target.value)}
          placeholder="Endosafe cartridge 0.05"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="cons-manufacturer">Manufacturer</Label>
          <Input
            id="cons-manufacturer"
            value={manufacturer}
            maxLength={200}
            onChange={e => setManufacturer(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cons-part">Part number</Label>
          <Input
            id="cons-part"
            value={partNumber}
            maxLength={100}
            onChange={e => setPartNumber(e.target.value)}
            className="font-mono"
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="cons-instrument">Instrument</Label>
        <select
          id="cons-instrument"
          className={SELECT}
          value={instrumentId ?? ''}
          onChange={e =>
            setInstrumentId(e.target.value ? Number(e.target.value) : null)
          }
        >
          <option value="">None</option>
          {instruments.map(i => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </div>
      {(kindDef?.specs ?? []).map(s => {
        const label = `${s.label}${s.unit ? ` (${s.unit})` : ''}`
        return locked ? (
          <dl key={s.key} className="text-sm">
            <dt className="flex items-center gap-1 font-medium text-muted-foreground">
              <Lock className="h-3 w-3" />
              {label}
            </dt>
            <dd className="mt-0.5 font-mono">
              {String(consumable?.specs[s.key] ?? '-')}
            </dd>
          </dl>
        ) : (
          <div key={s.key} className="space-y-2">
            <Label htmlFor={`cons-spec-${s.key}`}>{label}</Label>
            <Input
              id={`cons-spec-${s.key}`}
              inputMode="decimal"
              className="font-mono"
              value={specs[s.key] ?? ''}
              onChange={e => setSpecs({ ...specs, [s.key]: e.target.value })}
            />
          </div>
        )
      })}
      {locked && (
        <p className="text-xs text-muted-foreground">
          In use; retire and add a new one to change
        </p>
      )}
      {consumable && (
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch
            checked={!active}
            onCheckedChange={retired => setActive(!retired)}
            aria-label="Retired"
          />
          Retired
        </label>
      )}
      <Button onClick={handleSave} disabled={saving || !kind}>
        {saving ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Save className="mr-1 h-3.5 w-3.5" />
        )}
        {consumable ? 'Save' : 'Create'}
      </Button>
    </div>
  )
}

export default ConsumablesPage
