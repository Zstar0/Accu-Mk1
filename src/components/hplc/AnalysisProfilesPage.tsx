import { useState, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  Search,
  Plus,
  Pencil,
  Trash2,
  ClipboardList,
  X,
  Check,
  ChevronUp,
  ChevronDown,
  Info,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
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
  createAnalysisProfile,
  updateAnalysisProfile,
  deleteAnalysisProfile,
  setAnalysisProfileMembers,
  getAnalysisProfileMembers,
  getAnalysisServices,
  type AnalysisProfile,
  type AnalysisServiceRecord,
} from '@/lib/api'
import { useAnalysisProfiles, analysisProfilesQueryKeys } from '@/services/analysis-profiles'
import { useQueryClient } from '@tanstack/react-query'

// ─── Types ───────────────────────────────────────────────────────────────────

interface FormState {
  key: string
  name: string
  description: string
  is_addon: boolean | null
  vials_required: string
  sort_order: string
  active: boolean
  coa_section_title: string
  coa_archetype: string | null
  coa_sort_order: string
}

const DEFAULT_FORM: FormState = {
  key: '',
  name: '',
  description: '',
  is_addon: null,
  vials_required: '0',
  sort_order: '0',
  active: true,
  coa_section_title: '',
  coa_archetype: null,
  coa_sort_order: '0',
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AnalysisProfilesPage() {
  const queryClient = useQueryClient()
  const { data: profiles = [], isLoading: loading, error: queryError } = useAnalysisProfiles()
  const [searchInput, setSearchInput] = useState('')

  // Panel state
  const [panelOpen, setPanelOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<AnalysisProfile | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)

  // Membership editor state — an ORDERED list of service ids. Order becomes
  // sort_order on save: the row order in the profile's future COA section.
  const [allServices, setAllServices] = useState<AnalysisServiceRecord[]>([])
  const [selectedOrder, setSelectedOrder] = useState<number[]>([])
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [savingMembers, setSavingMembers] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')

  const refreshProfiles = useCallback(() => {
    return queryClient.invalidateQueries({ queryKey: analysisProfilesQueryKeys.all })
  }, [queryClient])

  const loadError = queryError
    ? (queryError instanceof Error ? queryError.message : 'Failed to load analysis profiles')
    : null

  // ── Panel helpers ──

  const openCreate = () => {
    setEditingProfile(null)
    setForm(DEFAULT_FORM)
    setAllServices([])
    setSelectedOrder([])
    setMemberSearch('')
    setPanelOpen(true)
  }

  const openEdit = async (profile: AnalysisProfile) => {
    setEditingProfile(profile)
    setForm({
      key: profile.key,
      name: profile.name,
      description: profile.description ?? '',
      is_addon: profile.is_addon,
      vials_required: String(profile.vials_required),
      sort_order: String(profile.sort_order),
      active: profile.active,
      coa_section_title: profile.coa_section_title ?? '',
      coa_archetype: profile.coa_archetype,
      coa_sort_order: String(profile.coa_sort_order),
    })
    setMemberSearch('')
    setPanelOpen(true)

    // member_ids on the list response is already sort_order-ordered, but it
    // can be up to 5min stale (useAnalysisProfiles' staleTime) — fetch fresh
    // membership here so Save Members can't silently revert a concurrent
    // edit made since the list last loaded.
    setLoadingMembers(true)
    try {
      const [services, memberIds] = await Promise.all([
        getAnalysisServices(),
        getAnalysisProfileMembers(profile.id),
      ])
      setAllServices(services)
      setSelectedOrder(memberIds)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load membership data')
    } finally {
      setLoadingMembers(false)
    }
  }

  const closePanel = () => {
    setPanelOpen(false)
    setEditingProfile(null)
    setForm(DEFAULT_FORM)
    setAllServices([])
    setSelectedOrder([])
  }

  // ── CRUD ──

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('Name is required')
      return
    }
    if (!editingProfile && !form.key.trim()) {
      toast.error('Key is required')
      return
    }
    if (form.is_addon === null) {
      toast.error('Choose whether this is a primary test or an add-on')
      return
    }
    setSaving(true)
    try {
      if (editingProfile) {
        await updateAnalysisProfile(editingProfile.id, {
          name: form.name.trim(),
          description: form.description.trim() || null,
          is_addon: form.is_addon,
          vials_required: parseInt(form.vials_required, 10) || 0,
          sort_order: parseInt(form.sort_order, 10) || 0,
          active: form.active,
          coa_section_title: form.coa_section_title.trim() || null,
          coa_archetype: form.coa_archetype,
          coa_sort_order: parseInt(form.coa_sort_order, 10) || 0,
        })
        toast.success(`"${form.name.trim()}" updated`)
      } else {
        await createAnalysisProfile({
          key: form.key.trim(),
          name: form.name.trim(),
          description: form.description.trim() || null,
          is_addon: form.is_addon,
          vials_required: parseInt(form.vials_required, 10) || 0,
          sort_order: parseInt(form.sort_order, 10) || 0,
        })
        toast.success(`"${form.name.trim()}" created`)
      }
      await refreshProfiles()
      closePanel()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (profile: AnalysisProfile) => {
    if (!window.confirm(`Delete "${profile.name}"? This cannot be undone.`)) return
    try {
      await deleteAnalysisProfile(profile.id)
      toast.success(`"${profile.name}" deleted`)
      await refreshProfiles()
      if (editingProfile?.id === profile.id) closePanel()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  // ── Membership ──

  const addMember = (id: number) => {
    setSelectedOrder(prev => (prev.includes(id) ? prev : [...prev, id]))
  }

  const removeMember = (id: number) => {
    setSelectedOrder(prev => prev.filter(sid => sid !== id))
  }

  const moveMember = (index: number, direction: -1 | 1) => {
    setSelectedOrder(prev => {
      const target = index + direction
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const temp = next[index]!
      next[index] = next[target]!
      next[target] = temp
      return next
    })
  }

  const handleSaveMembers = async () => {
    if (!editingProfile) return
    setSavingMembers(true)
    try {
      // Known gap (deferred): duplicate ids in one PUT payload 500 server
      // side — de-dupe defensively before sending, even though addMember
      // already prevents duplicates from entering selectedOrder.
      const deduped = [...new Set(selectedOrder)]
      const result = await setAnalysisProfileMembers(editingProfile.id, deduped)
      toast.success(`Membership saved — ${result.count} service${result.count !== 1 ? 's' : ''} assigned`)
      await refreshProfiles()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save membership')
    } finally {
      setSavingMembers(false)
    }
  }

  // ── Filtering ──

  const filtered = profiles.filter(p => {
    if (!searchInput) return true
    const q = searchInput.toLowerCase()
    return (
      p.name.toLowerCase().includes(q) ||
      p.key.toLowerCase().includes(q) ||
      (p.description?.toLowerCase().includes(q) ?? false)
    )
  })

  const serviceById = new Map(allServices.map(s => [s.id, s]))
  const filteredAvailable = allServices.filter(s => {
    if (selectedOrder.includes(s.id)) return false
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
          <ClipboardList className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Analysis Profiles</h1>
            <p className="text-sm text-muted-foreground">
              Sellable tests — the order-facing bundle of one or more analysis services
            </p>
          </div>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" />
          Add Profile
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
          placeholder="Search profiles..."
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
              <TableHead>Key</TableHead>
              <TableHead className="w-28 text-center">Type</TableHead>
              <TableHead className="w-24 text-center">Members</TableHead>
              <TableHead className="w-20 text-center">Active</TableHead>
              <TableHead className="w-24 text-center">Sort Order</TableHead>
              <TableHead className="w-24"></TableHead>
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
                  {profiles.length === 0
                    ? 'No analysis profiles yet. Click "Add Profile" to create one.'
                    : 'No profiles match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(profile => (
                <TableRow
                  key={profile.id}
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                  onClick={() => openEdit(profile)}
                >
                  <TableCell className="font-medium">{profile.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {profile.key}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant={profile.is_addon ? 'outline' : 'secondary'}>
                      {profile.is_addon ? 'Add-on' : 'Primary'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="secondary">{profile.member_ids.length}</Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    {profile.active ? (
                      <Check className="mx-auto h-4 w-4 text-emerald-600" />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">
                    {profile.sort_order}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={e => { e.stopPropagation(); openEdit(profile) }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={e => { e.stopPropagation(); handleDelete(profile) }}
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
                <ClipboardList className="h-5 w-5 text-primary" />
                <span className="text-lg font-semibold">
                  {editingProfile ? `Edit: ${editingProfile.name}` : 'New Analysis Profile'}
                </span>
              </div>
              <Button variant="ghost" size="icon" onClick={closePanel}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

              {/* Profile fields */}
              <div className="space-y-4">
                {/* Key */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    Key <span className="text-destructive">*</span>
                  </label>
                  <Input
                    placeholder="e.g. bpc157-core"
                    value={form.key}
                    disabled={!!editingProfile}
                    onChange={e => setForm(f => ({ ...f, key: e.target.value }))}
                    className="font-mono"
                  />
                  {editingProfile && (
                    <p className="text-xs text-muted-foreground">
                      Immutable once an order references it — cannot be changed here.
                    </p>
                  )}
                </div>

                {/* Name */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Name <span className="text-destructive">*</span></label>
                  <Input
                    placeholder="e.g. BPC-157 Core Panel"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  />
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

                {/* Type (is_addon) — required explicit choice, no default */}
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <label className="text-sm font-medium">
                      Type <span className="text-destructive">*</span>
                    </label>
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-default" />
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs">
                          <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                            <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                              Primary vs. add-on
                            </div>
                            <div><span className="font-semibold">Primary</span> — the base sellable test for an order.</div>
                            <div><span className="font-semibold">Add-on</span> — an upsell attached to an existing order.</div>
                            <div className="pt-1 opacity-80">No default on purpose — a mis-seeded value would silently demote a primary test.</div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <RadioGroup
                    value={form.is_addon === null ? undefined : (form.is_addon ? 'addon' : 'primary')}
                    onValueChange={v => setForm(f => ({ ...f, is_addon: v === 'addon' }))}
                    className="flex flex-row gap-4"
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="primary" id="type-primary" />
                      <Label htmlFor="type-primary" className="font-normal">Primary test</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="addon" id="type-addon" />
                      <Label htmlFor="type-addon" className="font-normal">Add-on</Label>
                    </div>
                  </RadioGroup>
                </div>

                {/* Vials required + Sort order */}
                <div className="flex gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Vials Required</label>
                    <Input
                      type="number"
                      min={0}
                      placeholder="0"
                      value={form.vials_required}
                      onChange={e => setForm(f => ({ ...f, vials_required: e.target.value }))}
                      className="max-w-[120px]"
                    />
                  </div>
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
                </div>

                {/* Active toggle — edit only. createAnalysisProfile's client
                    signature has no `active` field (the backend always
                    creates active=True), so showing this on create would let
                    an admin uncheck it and believe the profile was created
                    inactive when it wasn't. */}
                {editingProfile && (
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id="is-active"
                      checked={form.active}
                      onCheckedChange={checked =>
                        setForm(f => ({ ...f, active: checked === true }))
                      }
                    />
                    <label htmlFor="is-active" className="text-sm font-medium leading-none">
                      Active
                      <span className="block text-xs font-normal text-muted-foreground">
                        Inactive profiles are hidden from new orders
                      </span>
                    </label>
                  </div>
                )}

                {/* COA section wiring — edit only. A new profile always
                    starts unreported (coa_archetype NULL); the lab opts in
                    here once the profile exists. */}
                {editingProfile && (
                  <div className="space-y-4 border-t pt-4">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <label className="text-sm font-medium">COA Section</label>
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-default" />
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs">
                              <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                                <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                                  Certificate reporting
                                </div>
                                <div>
                                  <span className="font-semibold">Not reported</span> — internal-only; never appears on the COA.
                                </div>
                                <div>
                                  <span className="font-semibold">Limit table</span> — renders as Test / Result / Unit / Specification / Verdict on the certificate.
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <Select
                        value={form.coa_archetype ?? 'none'}
                        onValueChange={v =>
                          setForm(f => ({ ...f, coa_archetype: v === 'none' ? null : v }))
                        }
                      >
                        <SelectTrigger className="w-56">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Not reported</SelectItem>
                          <SelectItem value="limit_table">Limit table</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex gap-4">
                      <div className="flex-1 space-y-1.5">
                        <label className="text-sm font-medium">Section Title</label>
                        <Input
                          placeholder={form.name || 'Section title'}
                          value={form.coa_section_title}
                          disabled={form.coa_archetype === null}
                          onChange={e =>
                            setForm(f => ({ ...f, coa_section_title: e.target.value }))
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Section Order</label>
                        <Input
                          type="number"
                          placeholder="0"
                          value={form.coa_sort_order}
                          onChange={e =>
                            setForm(f => ({ ...f, coa_sort_order: e.target.value }))
                          }
                          className="max-w-[120px]"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Save profile button */}
              <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving}>
                  {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  {editingProfile ? 'Save Changes' : 'Create Profile'}
                </Button>
              </div>

              {/* Membership editor — only when editing an existing profile */}
              {editingProfile && (
                <div className="border-t pt-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <h3 className="text-sm font-semibold">Members</h3>
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3.5 w-3.5 text-muted-foreground cursor-default" />
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-xs">
                            <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                              <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                                Membership order
                              </div>
                              <div>List order becomes sort_order.</div>
                              <div>This is the row order in the profile's future COA section.</div>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
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
                      {/* Selected — ordered */}
                      <div className="space-y-1.5">
                        <p className="text-xs text-muted-foreground">
                          {selectedOrder.length} selected — order = COA row order
                        </p>
                        <div className="max-h-52 overflow-y-auto rounded-md border divide-y">
                          {selectedOrder.length === 0 ? (
                            <p className="py-4 text-center text-sm text-muted-foreground">
                              No members yet. Add services below.
                            </p>
                          ) : (
                            selectedOrder.map((id, index) => {
                              const svc = serviceById.get(id)
                              return (
                                <div
                                  key={id}
                                  className="flex items-center gap-3 px-3 py-2"
                                >
                                  <Badge variant="secondary" className="w-6 justify-center shrink-0 font-mono text-[10px]">
                                    {index + 1}
                                  </Badge>
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium truncate">
                                      {svc?.title ?? `Service #${id}`}
                                    </div>
                                    {svc?.keyword && (
                                      <div className="text-xs text-muted-foreground font-mono">
                                        {svc.keyword}
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-0.5 shrink-0">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      disabled={index === 0}
                                      onClick={() => moveMember(index, -1)}
                                    >
                                      <ChevronUp className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      disabled={index === selectedOrder.length - 1}
                                      onClick={() => moveMember(index, 1)}
                                    >
                                      <ChevronDown className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6 text-destructive hover:text-destructive"
                                      onClick={() => removeMember(id)}
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                </div>
                              )
                            })
                          )}
                        </div>
                      </div>

                      {/* Available — search + add */}
                      <div className="space-y-1.5">
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            placeholder="Filter services to add..."
                            value={memberSearch}
                            onChange={e => setMemberSearch(e.target.value)}
                            className="pl-8 h-8 text-sm"
                          />
                        </div>
                        <div className="max-h-52 overflow-y-auto rounded-md border divide-y">
                          {filteredAvailable.length === 0 ? (
                            <p className="py-4 text-center text-sm text-muted-foreground">
                              {allServices.length === 0
                                ? 'No analysis services found. Sync from SENAITE first.'
                                : 'No more services match your filter.'}
                            </p>
                          ) : (
                            filteredAvailable.map(svc => (
                              <button
                                key={svc.id}
                                type="button"
                                onClick={() => addMember(svc.id)}
                                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
                              >
                                <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm font-medium truncate">{svc.title}</div>
                                  {svc.keyword && (
                                    <div className="text-xs text-muted-foreground font-mono">
                                      {svc.keyword}
                                    </div>
                                  )}
                                </div>
                              </button>
                            ))
                          )}
                        </div>
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
