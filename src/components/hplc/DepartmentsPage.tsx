import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  Search,
  Plus,
  Pencil,
  Trash2,
  Building2,
  X,
  Check,
  Lock,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  SERVICE_GROUP_COLORS,
  COLOR_OPTIONS,
  type ServiceGroupColor,
} from '@/lib/service-group-colors'
import {
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  type Department,
} from '@/lib/api'

// ─── Types ───────────────────────────────────────────────────────────────────

interface FormState {
  name: string
  sort_order: string
  color: ServiceGroupColor
}

const DEFAULT_FORM: FormState = {
  name: '',
  sort_order: '0',
  color: 'blue',
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function DepartmentsPage() {
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')

  // Panel state
  const [panelOpen, setPanelOpen] = useState(false)
  const [editingDept, setEditingDept] = useState<Department | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)

  // ── Data loading ──

  const loadDepartments = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getDepartments()
      setDepartments(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load departments')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDepartments()
  }, [loadDepartments])

  // ── Panel helpers ──

  const openCreate = () => {
    setEditingDept(null)
    setForm(DEFAULT_FORM)
    setPanelOpen(true)
  }

  const openEdit = (dept: Department) => {
    setEditingDept(dept)
    setForm({
      name: dept.name,
      sort_order: String(dept.sort_order),
      color: (dept.color as ServiceGroupColor) ?? 'blue',
    })
    setPanelOpen(true)
  }

  const closePanel = () => {
    setPanelOpen(false)
    setEditingDept(null)
    setForm(DEFAULT_FORM)
  }

  // ── CRUD ──

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('Name is required')
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        sort_order: parseInt(form.sort_order, 10) || 0,
        color: form.color,
      }
      if (editingDept) {
        await updateDepartment(editingDept.id, payload)
        toast.success(`"${payload.name}" updated`)
      } else {
        await createDepartment(payload)
        toast.success(`"${payload.name}" created`)
      }
      await loadDepartments()
      closePanel()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (dept: Department) => {
    // is_system departments never reach here — the delete button is disabled
    // for them in the table (see the Trash2 button below). The backend's 400
    // guard is the authoritative check; this is belt-and-suspenders only.
    if (!window.confirm(`Delete "${dept.name}"? This cannot be undone.`)) return
    try {
      await deleteDepartment(dept.id)
      toast.success(`"${dept.name}" deleted`)
      await loadDepartments()
      if (editingDept?.id === dept.id) closePanel()
    } catch (err) {
      // Surfaces the backend's 409 verbatim ("...reassign them first") rather
      // than a generic failure message.
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  // ── Filtering ──

  const filtered = departments.filter(d => {
    if (!searchInput) return true
    return d.name.toLowerCase().includes(searchInput.toLowerCase())
  })

  // ── Render ──

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Building2 className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Departments</h1>
            <p className="text-sm text-muted-foreground">
              Structural home for analysis services and service groups
            </p>
          </div>
        </div>
        <Button onClick={openCreate}>
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
              <TableHead className="w-10">Color</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-24 text-center">Sort Order</TableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  {departments.length === 0
                    ? 'No departments yet. Click "Add Department" to create one.'
                    : 'No departments match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(dept => (
                <TableRow
                  key={dept.id}
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => openEdit(dept)}
                >
                  <TableCell>
                    <Badge
                      className={cn(
                        'h-5 w-5 rounded border p-0',
                        SERVICE_GROUP_COLORS[dept.color as ServiceGroupColor] ??
                          SERVICE_GROUP_COLORS.zinc
                      )}
                    >
                      <span className="sr-only">{dept.color}</span>
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center">
                      {dept.name}
                      {dept.is_system && (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge
                                variant="outline"
                                className="ml-2 gap-1 px-1.5 py-0 text-[10px] cursor-default"
                              >
                                <Lock className="h-2.5 w-2.5" />
                                System
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs">
                              <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                                <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                                  Protected department
                                </div>
                                <div>Seeded by the catalog foundation migration.</div>
                                <div>Name, color, and sort order stay editable — deletion is blocked.</div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">
                    {dept.sort_order}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={e => { e.stopPropagation(); openEdit(dept) }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={dept.is_system}
                        className={cn(
                          'h-7 w-7',
                          dept.is_system
                            ? 'text-muted-foreground/40'
                            : 'text-destructive hover:text-destructive'
                        )}
                        onClick={e => { e.stopPropagation(); handleDelete(dept) }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Slide-out panel */}
      {panelOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]"
            style={{ animation: 'fadeIn 0.2s ease-out' }}
            onClick={closePanel}
          />
          <div
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l bg-background shadow-xl"
            style={{ animation: 'slideInRight 0.25s ease-out' }}
          >
            {/* Sticky header */}
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-6 py-4">
              <div className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-primary" />
                <span className="text-lg font-semibold">
                  {editingDept ? `Edit: ${editingDept.name}` : 'New Department'}
                </span>
              </div>
              <Button variant="ghost" size="icon" onClick={closePanel}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              <div className="space-y-4">
                {/* Name */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Name <span className="text-destructive">*</span></label>
                  <Input
                    placeholder="e.g. Microbiology"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  />
                </div>

                {/* Sort order */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Sort Order</label>
                  <Input
                    type="number"
                    placeholder="0"
                    value={form.sort_order}
                    onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))}
                    className="max-w-[120px]"
                  />
                </div>

                {/* Color picker */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Color</label>
                  <div className="grid grid-cols-4 gap-2">
                    {COLOR_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setForm(f => ({ ...f, color: opt.value }))}
                        className={cn(
                          'flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-all',
                          SERVICE_GROUP_COLORS[opt.value],
                          form.color === opt.value
                            ? 'ring-2 ring-primary ring-offset-1'
                            : 'opacity-70 hover:opacity-100'
                        )}
                      >
                        {form.color === opt.value && (
                          <Check className="h-3 w-3 shrink-0" />
                        )}
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {editingDept?.is_system && (
                  <p className="text-xs text-muted-foreground">
                    This is a protected system department — it cannot be deleted, but its
                    name, color, and sort order can still be edited here.
                  </p>
                )}
              </div>

              {/* Save button */}
              <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving}>
                  {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  {editingDept ? 'Save Changes' : 'Create Department'}
                </Button>
              </div>
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
