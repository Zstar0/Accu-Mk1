import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  Search,
  Plus,
  ChevronRight,
  X,
  Layers,
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
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  getServiceGroups,
  type Department,
  type ServiceGroup,
} from '@/lib/api'
import {
  COLOR_OPTIONS,
  SERVICE_GROUP_COLORS,
} from '@/lib/service-group-colors'

export function DepartmentsPage() {
  const [departments, setDepartments] = useState<Department[]>([])
  const [groups, setGroups] = useState<ServiceGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [mode, setMode] = useState<'view' | 'add'>('view')
  const [searchInput, setSearchInput] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [deptData, groupData] = await Promise.all([
        getDepartments(),
        getServiceGroups(),
      ])
      setDepartments(deptData)
      setGroups(groupData)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load departments')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const selectedDepartment = departments.find(d => d.id === selectedId) ?? null

  const filtered = departments.filter(d => {
    if (!searchInput) return true
    return d.name.toLowerCase().includes(searchInput.toLowerCase())
  })

  const flyoutOpen = mode === 'add' || selectedId !== null

  const handleClose = () => {
    setSelectedId(null)
    setMode('view')
  }

  const handleSaved = async () => {
    setSelectedId(null)
    setMode('view')
    await load()
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Layers className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Departments</h1>
            <p className="text-sm text-muted-foreground">
              Organize service groups into departments
            </p>
          </div>
        </div>
        <Button onClick={() => { setSelectedId(null); setMode('add') }}>
          <Plus className="mr-1 h-4 w-4" />
          Add Department
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
          placeholder="Search departments..."
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
              <TableHead>Name</TableHead>
              <TableHead>Sort Order</TableHead>
              <TableHead>Service Groups</TableHead>
              <TableHead>System</TableHead>
              <TableHead className="w-12.5"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  {departments.length === 0
                    ? 'No departments yet. Click "Add Department" to create one.'
                    : 'No departments match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(dept => (
                <TableRow
                  key={dept.id}
                  className={`cursor-pointer transition-colors hover:bg-muted/50 ${
                    selectedId === dept.id ? 'bg-muted/50' : ''
                  }`}
                  onClick={() => { setSelectedId(dept.id); setMode('view') }}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block h-3 w-3 rounded-full ${
                          SERVICE_GROUP_COLORS[dept.color as keyof typeof SERVICE_GROUP_COLORS] ?? ''
                        }`}
                      />
                      <span className="font-medium">{dept.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>{dept.sort_order}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{dept.group_count}</Badge>
                  </TableCell>
                  <TableCell>
                    {dept.is_system ? <Badge variant="outline">System</Badge> : '—'}
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
      {flyoutOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]"
            style={{ animation: 'fadeIn 0.2s ease-out' }}
            onClick={handleClose}
          />
          <div
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l bg-background shadow-xl"
            style={{ animation: 'slideInRight 0.25s ease-out' }}
          >
            {/* Sticky header */}
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-6 py-4">
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-primary" />
                <span className="text-lg font-semibold">
                  {mode === 'add' ? 'New Department' : (selectedDepartment?.name ?? 'Department')}
                </span>
              </div>
              <Button variant="ghost" size="icon" onClick={handleClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <DepartmentFlyout
                key={selectedId ?? 'add'}
                mode={mode === 'add' ? 'add' : 'view'}
                department={selectedDepartment}
                groups={groups}
                onClose={handleClose}
                onSaved={handleSaved}
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

// ─── Department Flyout ────────────────────────────────────────────────────────

function DepartmentFlyout({
  mode,
  department,
  groups,
  onClose,
  onSaved,
}: {
  mode: 'add' | 'view'
  department: Department | null
  groups: ServiceGroup[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(department?.name ?? '')
  const [color, setColor] = useState(department?.color ?? 'blue')
  const [sortOrder, setSortOrder] = useState(department?.sort_order ?? 0)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const deptGroups = department
    ? groups.filter(g => g.department_id === department.id)
    : []

  const save = async () => {
    setSaving(true)
    setErr(null)
    try {
      if (mode === 'add') {
        await createDepartment({ name: name.trim(), color, sort_order: sortOrder })
        toast.success('Department created')
      } else if (department) {
        await updateDepartment(department.id, { name: name.trim(), color, sort_order: sortOrder })
        toast.success('Department updated')
      }
      onSaved()
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed'
      setErr(m)
      toast.error(m)
    } finally {
      setSaving(false)
    }
  }

  const del = async () => {
    if (!department) return
    if (!window.confirm(`Delete department '${department.name}'? This cannot be undone.`)) return
    setSaving(true)
    setErr(null)
    try {
      await deleteDepartment(department.id)
      toast.success('Department deleted')
      onSaved()
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Delete failed'
      setErr(m)
      toast.error(m)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      {err && <div className="text-sm text-destructive">{err}</div>}
      <div className="space-y-1">
        <label className="text-sm font-medium">Name</label>
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Department name"
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Color</label>
        <div className="flex flex-wrap gap-2">
          {COLOR_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setColor(opt.value)}
              className={`h-7 w-7 rounded-full border-2 ${
                color === opt.value ? 'border-foreground' : 'border-transparent'
              }`}
              title={opt.label}
            >
              <span
                className={`block h-full w-full rounded-full ${SERVICE_GROUP_COLORS[opt.value]}`}
              />
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Sort Order</label>
        <Input
          type="number"
          value={sortOrder}
          onChange={e => setSortOrder(Number(e.target.value))}
          className="max-w-32"
        />
      </div>

      {mode === 'view' && department && (
        <>
          <div className="text-xs text-muted-foreground">
            {department.is_system && (
              <Badge variant="outline" className="mr-2">System</Badge>
            )}
            Service Groups: {department.group_count} · Services: {department.service_count}
          </div>
          <div className="border-t pt-4">
            <h4 className="mb-2 text-sm font-semibold text-muted-foreground">
              Service Groups ({deptGroups.length})
            </h4>
            {deptGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No service groups in this department.
              </p>
            ) : (
              <div className="space-y-1">
                {deptGroups.map(g => (
                  <div
                    key={g.id}
                    className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
                  >
                    <span>{g.name}</span>
                    <Badge variant="secondary" className="text-xs">
                      {g.member_count} service{g.member_count !== 1 ? 's' : ''}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <div className="flex items-center gap-2 border-t pt-4">
        <Button onClick={save} disabled={saving || !name.trim()}>
          {mode === 'add' ? 'Create' : 'Save'}
        </Button>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        {mode === 'view' && department && !department.is_system && (
          <Button
            variant="destructive"
            className="ml-auto"
            onClick={del}
            disabled={saving}
          >
            Delete
          </Button>
        )}
      </div>
    </div>
  )
}
