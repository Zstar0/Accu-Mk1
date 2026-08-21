import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  Search,
  Pencil,
  Layers,
  X,
  Check,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  SERVICE_GROUP_COLORS,
  COLOR_OPTIONS,
  type ServiceGroupColor,
} from '@/lib/service-group-colors'
import {
  getServiceGroups,
  updateServiceGroup,
  getServiceGroupMembers,
  setServiceGroupMembers,
  getAnalysisServices,
  getSlaTiers,
  type ServiceGroup,
  type AnalysisServiceRecord,
  type SlaTier,
} from '@/lib/api'

// Service groups are frozen legacy rows as of S2 — departments own worksheet
// and inbox routing now. The backend 410s creation, 400s a rename (FE keyword
// maps and the COA gate's group half key on the names), and 409s a delete that
// any worksheet item / SLA tier / member row still references. This page keeps
// only what still works: membership (PUT /members stays open until the gate
// union has bedded in) and the group-keyed SLA tier, which departments don't
// take over until S7.

// ─── Types ───────────────────────────────────────────────────────────────────

interface FormState {
  description: string
  color: ServiceGroupColor
  sort_order: string
  is_default: boolean
  sla_tier_id: string
}

const DEFAULT_FORM: FormState = {
  description: '',
  color: 'blue',
  sort_order: '0',
  is_default: false,
  sla_tier_id: '',
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ServiceGroupsPage() {
  const [groups, setGroups] = useState<ServiceGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')

  // Panel state
  const [panelOpen, setPanelOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<ServiceGroup | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)

  const [tiers, setTiers] = useState<SlaTier[]>([])

  // Membership editor state
  const [allServices, setAllServices] = useState<AnalysisServiceRecord[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [savingMembers, setSavingMembers] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')

  // ── Data loading ──

  const loadGroups = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getServiceGroups()
      setGroups(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load service groups')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGroups()
    getSlaTiers().then(setTiers).catch(_err => { /* non-critical: tiers default to empty */ })
  }, [loadGroups])

  // ── Panel helpers ──

  const openEdit = async (group: ServiceGroup) => {
    setEditingGroup(group)
    setForm({
      description: group.description ?? '',
      color: (group.color as ServiceGroupColor) ?? 'blue',
      sort_order: String(group.sort_order),
      is_default: group.is_default,
      sla_tier_id: group.sla_tier_id != null ? String(group.sla_tier_id) : '',
    })
    setMemberSearch('')
    setPanelOpen(true)

    // Load analysis services + current members in parallel
    setLoadingMembers(true)
    try {
      const [services, memberIds] = await Promise.all([
        getAnalysisServices(),
        getServiceGroupMembers(group.id),
      ])
      setAllServices(services)
      setSelectedIds(new Set(memberIds))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load membership data')
    } finally {
      setLoadingMembers(false)
    }
  }

  const closePanel = () => {
    setPanelOpen(false)
    setEditingGroup(null)
    setForm(DEFAULT_FORM)
    setAllServices([])
    setSelectedIds(new Set())
  }

  // ── CRUD ──

  const handleSave = async () => {
    if (!editingGroup) return
    setSaving(true)
    try {
      // `name` is deliberately absent: the backend 400s a rename, and
      // ServiceGroupUpdate is exclude_unset, so omitting it makes the freeze
      // structural rather than "we happened to send the same string back".
      await updateServiceGroup(editingGroup.id, {
        description: form.description.trim() || null,
        color: form.color,
        sort_order: parseInt(form.sort_order, 10) || 0,
        is_default: form.is_default,
        sla_tier_id: form.sla_tier_id ? Number(form.sla_tier_id) : null,
      })
      toast.success(`"${editingGroup.name}" updated`)
      await loadGroups()
      closePanel()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // ── Membership ──

  const toggleMember = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSaveMembers = async () => {
    if (!editingGroup) return
    setSavingMembers(true)
    try {
      const result = await setServiceGroupMembers(editingGroup.id, [...selectedIds])
      toast.success(`Membership saved — ${result.count} service${result.count !== 1 ? 's' : ''} assigned`)
      await loadGroups()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save membership')
    } finally {
      setSavingMembers(false)
    }
  }

  // ── Filtering ──

  const filtered = groups.filter(g => {
    if (!searchInput) return true
    const q = searchInput.toLowerCase()
    return (
      g.name.toLowerCase().includes(q) ||
      (g.description?.toLowerCase().includes(q) ?? false)
    )
  })

  // Build set of service IDs claimed by OTHER groups (not the one being edited)
  const takenIds = new Set(
    groups
      .filter(g => g.id !== editingGroup?.id)
      .flatMap(g => g.member_ids)
  )

  const filteredServices = allServices.filter(s => {
    // Hide services already assigned to another group
    if (takenIds.has(s.id)) return false
    if (!memberSearch) return true
    const q = memberSearch.toLowerCase()
    return (
      (s.title?.toLowerCase().includes(q) ?? false) ||
      (s.keyword?.toLowerCase().includes(q) ?? false) ||
      (s.category?.toLowerCase().includes(q) ?? false)
    )
  })

  // ── Render ──

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Layers className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Service Groups</h1>
            <p className="text-sm text-muted-foreground">
              Group analysis services by discipline or department
            </p>
          </div>
        </div>
      </div>

      {/* Legacy banner — groups no longer route anything (S2) */}
      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardContent className="flex items-center gap-2 py-3">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
          <span className="text-sm">
            Legacy — departments own routing now. Groups remain for historical rows and SLA tiers.
          </span>
        </CardContent>
      </Card>

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
          placeholder="Search groups..."
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
              <TableHead>Description</TableHead>
              <TableHead className="w-24 text-center">Members</TableHead>
              <TableHead className="w-24 text-center">Sort Order</TableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  {groups.length === 0
                    ? 'No service groups. New routing is defined by departments.'
                    : 'No groups match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(group => (
                <TableRow
                  key={group.id}
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => openEdit(group)}
                >
                  <TableCell>
                    <Badge
                      className={cn(
                        'h-5 w-5 rounded border p-0',
                        SERVICE_GROUP_COLORS[group.color as ServiceGroupColor] ??
                          SERVICE_GROUP_COLORS.zinc
                      )}
                    >
                      <span className="sr-only">{group.color}</span>
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">
                    {group.name}
                    {group.is_default && (
                      <Badge variant="outline" className="ml-2 text-[10px] px-1.5 py-0">
                        Default
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-sm text-muted-foreground">
                    {group.description ?? '—'}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="secondary">{group.member_count}</Badge>
                  </TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">
                    {group.sort_order}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={`Edit ${group.name}`}
                        onClick={e => { e.stopPropagation(); openEdit(group) }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
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
                <Layers className="h-5 w-5 text-primary" />
                <span className="text-lg font-semibold">
                  {editingGroup ? `Edit: ${editingGroup.name}` : 'Service Group'}
                </span>
              </div>
              <Button variant="ghost" size="icon" onClick={closePanel}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

              {/* Group fields */}
              <div className="space-y-4">
                {/* Name — frozen: FE keyword maps and the COA gate's group
                    half key on these strings, so the backend refuses renames */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Name</label>
                  <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                    {editingGroup?.name ?? '—'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Frozen — group names are referenced by historical rows.
                  </p>
                </div>

                {/* Description */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Description</label>
                  <Input
                    placeholder="Optional description"
                    value={form.description}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  />
                </div>

                {/* SLA tier */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">SLA tier</label>
                  <Select
                    value={form.sla_tier_id || 'default'}
                    onValueChange={v =>
                      setForm(f => ({ ...f, sla_tier_id: v === 'default' ? '' : v }))
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Use default SLA</SelectItem>
                      {tiers.map(ti => (
                        <SelectItem key={ti.id} value={String(ti.id)}>{ti.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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

                {/* Default group toggle */}
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="is-default"
                    checked={form.is_default}
                    onCheckedChange={checked =>
                      setForm(f => ({ ...f, is_default: checked === true }))
                    }
                  />
                  <label htmlFor="is-default" className="text-sm font-medium leading-none">
                    Default group
                    <span className="block text-xs font-normal text-muted-foreground">
                      Unassigned services automatically fall into this group
                    </span>
                  </label>
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
              </div>

              {/* Save group button */}
              <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving || !editingGroup}>
                  {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  Save Changes
                </Button>
              </div>

              {/* Membership editor — only when editing an existing group */}
              {editingGroup && (
                <div className="border-t pt-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold">Members</h3>
                      <p className="text-xs text-muted-foreground">
                        Analysis services assigned to this group
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleSaveMembers}
                      disabled={savingMembers || loadingMembers}
                    >
                      {savingMembers && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                      Save Members
                    </Button>
                  </div>

                  {loadingMembers ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <>
                      {/* Member search */}
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          placeholder="Filter services..."
                          value={memberSearch}
                          onChange={e => setMemberSearch(e.target.value)}
                          className="pl-8 h-8 text-sm"
                        />
                      </div>

                      {/* Selection summary */}
                      <p className="text-xs text-muted-foreground">
                        {selectedIds.size} of {allServices.length} selected
                      </p>

                      {/* Checkbox list */}
                      <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
                        {filteredServices.length === 0 ? (
                          <p className="py-4 text-center text-sm text-muted-foreground">
                            {allServices.length === 0
                              ? 'No analysis services found. Create them on the Analysis Services page first.'
                              : 'No services match your filter.'}
                          </p>
                        ) : (
                          filteredServices.map(svc => (
                            <label
                              key={svc.id}
                              className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40 transition-colors"
                            >
                              <Checkbox
                                checked={selectedIds.has(svc.id)}
                                onCheckedChange={() => toggleMember(svc.id)}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium truncate">{svc.title}</div>
                                {svc.keyword && (
                                  <div className="text-xs text-muted-foreground font-mono">
                                    {svc.keyword}
                                  </div>
                                )}
                              </div>
                            </label>
                          ))
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
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
