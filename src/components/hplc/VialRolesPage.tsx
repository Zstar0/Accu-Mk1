import { useState, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  Search,
  Plus,
  Pencil,
  Trash2,
  Tag,
  X,
  Info,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
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
import {
  createVialRole,
  updateVialRole,
  deleteVialRole,
  type VialRoleRow,
} from '@/lib/api'
import { useVialRoles, vialRolesQueryKeys } from '@/services/vial-roles'
import { useDepartments } from '@/services/departments'
import { useQueryClient } from '@tanstack/react-query'

// ─── Types ───────────────────────────────────────────────────────────────────

interface FormState {
  code: string
  label: string
  department_id: number | null
  boxable: boolean
  variance_eligible: boolean
  sort_order: string
}

const DEFAULT_FORM: FormState = {
  code: '',
  label: '',
  department_id: null,
  boxable: false,
  variance_eligible: false,
  sort_order: '0',
}

// Mirrors the backend's code format check (main.py, both POST and PATCH on
// /vial-roles) — a client-side echo, not the authority. The backend still
// 400s on anything this misses; this is UX so admins don't discover the
// constraint via a raw error toast.
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,7}$/
const CODE_ERROR =
  'Must be lowercase, start with a letter, letters/digits/underscore only, ≤ 8 chars'

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function VialRolesPage() {
  const queryClient = useQueryClient()
  const { data: roles = [], isLoading: loading, error: queryError } = useVialRoles()
  const { data: departments = [] } = useDepartments()
  const [searchInput, setSearchInput] = useState('')

  // Panel state
  const [panelOpen, setPanelOpen] = useState(false)
  const [editingRole, setEditingRole] = useState<VialRoleRow | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)

  const refreshRoles = useCallback(() => {
    return queryClient.invalidateQueries({ queryKey: vialRolesQueryKeys.all })
  }, [queryClient])

  const loadError = queryError
    ? (queryError instanceof Error ? queryError.message : 'Failed to load vial roles')
    : null

  const codeInvalid = form.code !== '' && !CODE_PATTERN.test(form.code)

  const departmentById = new Map(departments.map(d => [d.id, d]))

  // ── Panel helpers ──

  const openCreate = () => {
    setEditingRole(null)
    // Every code but xtra requires a department; default to the first loaded
    // one so a new role isn't silently rejected by the backend's non-null
    // guard the moment the admin forgets to touch the select.
    setForm({ ...DEFAULT_FORM, department_id: departments[0]?.id ?? null })
    setPanelOpen(true)
  }

  const openEdit = (role: VialRoleRow) => {
    setEditingRole(role)
    setForm({
      code: role.code,
      label: role.label,
      department_id: role.department_id,
      boxable: role.boxable,
      variance_eligible: role.variance_eligible,
      sort_order: String(role.sort_order),
    })
    setPanelOpen(true)
  }

  const closePanel = () => {
    setPanelOpen(false)
    setEditingRole(null)
    setForm(DEFAULT_FORM)
  }

  // ── CRUD ──

  const handleSave = async () => {
    if (!form.label.trim()) {
      toast.error('Label is required')
      return
    }
    if (!editingRole && !form.code.trim()) {
      toast.error('Code is required')
      return
    }
    if (codeInvalid) {
      toast.error(CODE_ERROR)
      return
    }
    if (form.department_id === null && form.code.trim() !== 'xtra') {
      toast.error('Only xtra may have no department')
      return
    }
    setSaving(true)
    try {
      if (editingRole) {
        await updateVialRole(editingRole.id, {
          // frozen rows refuse a code change server-side; omit it entirely
          // when unchanged so a stray resend of the disabled field never
          // trips that guard on an untouched row.
          ...(form.code.trim() !== editingRole.code ? { code: form.code.trim() } : {}),
          label: form.label.trim(),
          department_id: form.department_id,
          boxable: form.boxable,
          variance_eligible: form.variance_eligible,
          sort_order: parseInt(form.sort_order, 10) || 0,
        })
        toast.success(`"${form.label.trim()}" updated`)
      } else {
        await createVialRole({
          code: form.code.trim(),
          label: form.label.trim(),
          department_id: form.department_id,
          boxable: form.boxable,
          variance_eligible: form.variance_eligible,
          sort_order: parseInt(form.sort_order, 10) || 0,
        })
        toast.success(`"${form.label.trim()}" created`)
      }
      await refreshRoles()
      closePanel()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (role: VialRoleRow) => {
    if (!window.confirm(`Delete "${role.label}"? This cannot be undone.`)) return
    try {
      await deleteVialRole(role.id)
      toast.success(`"${role.label}" deleted`)
      await refreshRoles()
      if (editingRole?.id === role.id) closePanel()
    } catch (err) {
      // Backend 409s name exactly what still references the role (a profile
      // or a vial) — that message is the point of surfacing it verbatim
      // rather than a generic "delete failed".
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  // ── Filtering ──

  const filtered = roles.filter(r => {
    if (!searchInput) return true
    const q = searchInput.toLowerCase()
    return r.code.toLowerCase().includes(q) || r.label.toLowerCase().includes(q)
  })

  // ── Render ──

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Tag className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Vial Roles</h1>
            <p className="text-sm text-muted-foreground">
              Catalog-driven bench roles — the assignment_role join key on every vial
            </p>
          </div>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" />
          Add Role
        </Button>
      </div>

      {/* Error */}
      {loadError && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 py-3">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <span className="text-sm text-destructive">{loadError}</span>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search roles..."
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
              <TableHead>Code</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Department</TableHead>
              <TableHead className="w-20 text-center">Boxable</TableHead>
              <TableHead className="w-24 text-center">Variance</TableHead>
              <TableHead className="w-24 text-center">Sort Order</TableHead>
              <TableHead className="w-32 text-center">Status</TableHead>
              <TableHead className="w-24"></TableHead>
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
                  {roles.length === 0
                    ? 'No vial roles yet. Click "Add Role" to create one.'
                    : 'No roles match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(role => (
                <TableRow
                  key={role.id}
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => openEdit(role)}
                >
                  <TableCell className="font-mono text-xs">{role.code}</TableCell>
                  <TableCell className="font-medium">{role.label}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {role.department_id !== null
                      ? (departmentById.get(role.department_id)?.name ?? `#${role.department_id}`)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant={role.boxable ? 'secondary' : 'outline'}>
                      {role.boxable ? 'Yes' : 'No'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant={role.variance_eligible ? 'secondary' : 'outline'}>
                      {role.variance_eligible ? 'Yes' : 'No'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">
                    {role.sort_order}
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      {role.is_system && <Badge variant="secondary">System</Badge>}
                      {role.frozen && <Badge variant="outline">Frozen</Badge>}
                      {!role.is_system && !role.frozen && (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={e => { e.stopPropagation(); openEdit(role) }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        aria-label={`Delete ${role.code}`}
                        disabled={role.is_system}
                        onClick={e => { e.stopPropagation(); handleDelete(role) }}
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
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl flex-col border-l bg-background shadow-xl"
            style={{ animation: 'slideInRight 0.25s ease-out' }}
          >
            {/* Sticky header */}
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-6 py-4">
              <div className="flex items-center gap-2">
                <Tag className="h-5 w-5 text-primary" />
                <span className="text-lg font-semibold">
                  {editingRole ? `Edit: ${editingRole.label}` : 'New Vial Role'}
                </span>
              </div>
              <Button variant="ghost" size="icon" onClick={closePanel}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              <div className="space-y-4">
                {/* Code */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    Code <span className="text-destructive">*</span>
                  </label>
                  <Input
                    placeholder="e.g. tox"
                    value={form.code}
                    maxLength={8}
                    disabled={!!editingRole && editingRole.frozen}
                    aria-invalid={codeInvalid}
                    onChange={e =>
                      setForm(f => ({ ...f, code: e.target.value.toLowerCase() }))
                    }
                    className="font-mono max-w-[160px]"
                  />
                  {editingRole?.frozen ? (
                    <p className="text-xs text-muted-foreground">
                      Immutable once a vial references it — cannot be changed here.
                    </p>
                  ) : (
                    <p className={codeInvalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                      {codeInvalid ? CODE_ERROR : 'lowercase, ≤ 8 chars, e.g. tox — the assignment_role DB value'}
                    </p>
                  )}
                </div>

                {/* Label */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Label <span className="text-destructive">*</span></label>
                  <Input
                    placeholder="e.g. Toxicology"
                    value={form.label}
                    onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                  />
                </div>

                {/* Department */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Department</label>
                  <Select
                    value={form.department_id !== null ? String(form.department_id) : ''}
                    onValueChange={v => setForm(f => ({ ...f, department_id: Number(v) }))}
                  >
                    <SelectTrigger className="w-56">
                      <SelectValue placeholder="Select a department" />
                    </SelectTrigger>
                    <SelectContent>
                      {departments.map(dep => (
                        <SelectItem key={dep.id} value={String(dep.id)}>
                          {dep.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Only the reserved xtra role may have no department.
                  </p>
                </div>

                {/* Sort order */}
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <label className="text-sm font-medium">Sort Order</label>
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-default" />
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs">
                          <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                            <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                              Sort Order
                            </div>
                            <div>Lower numbers come first. Drives three things at once:</div>
                            <div className="pt-1 opacity-80">
                              Auto-assign fill priority — which role a vial lands in first when the wizard assigns automatically.
                            </div>
                            <div className="opacity-80">
                              Vial-plan section ordering — the order departments/roles render on the assign screen.
                            </div>
                            <div className="opacity-80">
                              Inbox lane ordering — the order worksheet-inbox filter chips appear in.
                            </div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <Input
                    type="number"
                    placeholder="0"
                    value={form.sort_order}
                    onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))}
                    className="max-w-[120px]"
                  />
                </div>

                {/* Boxable */}
                <div className="flex items-center gap-3">
                  <Switch
                    id="role-boxable"
                    checked={form.boxable}
                    onCheckedChange={checked => setForm(f => ({ ...f, boxable: checked }))}
                  />
                  <div className="flex items-center gap-1.5">
                    <label htmlFor="role-boxable" className="text-sm font-medium leading-none">
                      Boxable
                    </label>
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-default" />
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs">
                          <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                            <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                              Boxable
                            </div>
                            <div>Vials with this role appear in the physical box-and-print check-in workflow.</div>
                            <div className="pt-1 opacity-80">
                              Off means this role never generates a box label or shows up on the boxing screen.
                            </div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>

                {/* Variance eligible */}
                <div className="flex items-center gap-3">
                  <Switch
                    id="role-variance"
                    checked={form.variance_eligible}
                    onCheckedChange={checked => setForm(f => ({ ...f, variance_eligible: checked }))}
                  />
                  <div className="flex items-center gap-1.5">
                    <label htmlFor="role-variance" className="text-sm font-medium leading-none">
                      Variance Eligible
                    </label>
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-default" />
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs">
                          <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                            <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                              Variance Eligible
                            </div>
                            <div>Vials with this role can be assigned into a variance set for BW/variance statistics.</div>
                            <div className="pt-1 opacity-80">
                              Off excludes the role from variance-set assignment entirely.
                            </div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>
              </div>

              {/* Save button */}
              <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving}>
                  {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  {editingRole ? 'Save Changes' : 'Create Role'}
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
