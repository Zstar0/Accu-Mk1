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
import { Textarea } from '@/components/ui/textarea'
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
  getRideHosts,
  putRideHosts,
  getMethods,
  type AnalysisProfile,
  type AnalysisServiceRecord,
  type HplcMethod,
} from '@/lib/api'
import NewTestOnboardingGuide from '@/components/hplc/NewTestOnboardingGuide'
import { useAnalysisProfiles, analysisProfilesQueryKeys } from '@/services/analysis-profiles'
import { useVialRoles, vialRolesQueryKeys } from '@/services/vial-roles'
import { useDepartments } from '@/services/departments'
import { useSlaTiers } from '@/services/sla'
import { suggestRoleCode } from '@/lib/role-code'
import { useQueryClient } from '@tanstack/react-query'

// ─── Types ───────────────────────────────────────────────────────────────────

interface FormState {
  key: string
  name: string
  description: string
  is_addon: boolean | null
  vials_required: string
  analytical_vials: string
  sort_order: string
  active: boolean
  coa_section_title: string
  coa_archetype: string | null
  coa_sort_order: string
  // Task 6: certificate display copy — same "inert until archetype armed"
  // contract as coa_section_title/coa_sort_order above.
  coa_basis_note: string
  coa_method_text: string
  coa_prep_text: string
  coa_footnotes: { label: string; text: string }[]
  fulfillment_role: string
  fulfillment_dim: 'role' | 'kind'
  // Task 11: beats the member services' group tier, loses to a priority
  // override. null = "— inherit group SLA —" (the pre-Task-11 default).
  sla_tier_id: number | null
  // Auto-mint (Task 3): department for a role this save might newly mint.
  // Not a persisted profile field — see api.ts's role_department_id doc.
  role_department_id: number | null
  // Same auto-mint-only contract: boxable for a role this save might mint.
  role_boxable: boolean
}

const DEFAULT_FORM: FormState = {
  key: '',
  name: '',
  description: '',
  is_addon: null,
  vials_required: '0',
  analytical_vials: '',
  sort_order: '0',
  active: true,
  coa_section_title: '',
  coa_archetype: null,
  coa_sort_order: '0',
  coa_basis_note: '',
  coa_method_text: '',
  coa_prep_text: '',
  coa_footnotes: [],
  fulfillment_role: '',
  fulfillment_dim: 'role',
  sla_tier_id: null,
  role_department_id: null,
  role_boxable: false,
}

// Mirrors the backend's assignment_role format check (main.py, both POST and
// PATCH) — a client-side echo, not the authority. The backend still 400s on
// anything this misses; this is UX so admins don't discover the constraint
// via a raw error toast.
const FULFILLMENT_ROLE_PATTERN = /^[a-z][a-z0-9_]{0,7}$/
const FULFILLMENT_ROLE_ERROR =
  'Must be lowercase, start with a letter, letters/digits/underscore only, ≤ 8 chars'

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AnalysisProfilesPage() {
  const queryClient = useQueryClient()
  const { data: profiles = [], isLoading: loading, error: queryError } = useAnalysisProfiles()
  const { data: vialRoles = [] } = useVialRoles()
  const { data: departments = [] } = useDepartments()
  const { data: slaTiers = [] } = useSlaTiers()
  const [searchInput, setSearchInput] = useState('')

  // Panel state
  const [panelOpen, setPanelOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<AnalysisProfile | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)

  // Membership editor state — an ORDERED list of service ids. Order becomes
  // sort_order on save: the row order in the profile's future COA section.
  const [allServices, setAllServices] = useState<AnalysisServiceRecord[]>([])
  // Task 8: methods catalog, loaded alongside member services so "Suggest
  // from methods" can resolve member default_method_ids to method rows
  // without a dedicated endpoint. Best-effort — see openEdit's .catch below.
  const [allMethods, setAllMethods] = useState<HplcMethod[]>([])
  const [selectedOrder, setSelectedOrder] = useState<number[]>([])
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [savingMembers, setSavingMembers] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')

  // Ride-hosts editor state (spec 4) — an ORDERED list of host role codes.
  // Order becomes priority on save (0 = first choice); see catalog_demand.
  // resolve_catalog_fulfillment. Separate save action from the profile
  // fields, same pattern as Members above.
  const [rideHosts, setRideHosts] = useState<string[]>([])
  const [loadingRideHosts, setLoadingRideHosts] = useState(false)
  const [savingRideHosts, setSavingRideHosts] = useState(false)

  const refreshProfiles = useCallback(() => {
    // Both invalidated together: a save here can mint a vial_roles row
    // (auto-mint, Task 3) or backfill one's department, so the vial-roles
    // admin page must not keep serving a stale registry after a profile save.
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: analysisProfilesQueryKeys.all }),
      queryClient.invalidateQueries({ queryKey: vialRolesQueryKeys.all }),
    ])
  }, [queryClient])

  const loadError = queryError
    ? (queryError instanceof Error ? queryError.message : 'Failed to load analysis profiles')
    : null

  // Empty role is valid (rides an existing vial); the format constraint only
  // binds when the effective dim is 'role' — mirrors the backend's gating.
  const fulfillmentRoleInvalid =
    form.fulfillment_dim === 'role' &&
    form.fulfillment_role !== '' &&
    !FULFILLMENT_ROLE_PATTERN.test(form.fulfillment_role)

  // Auto-mint UX (Task 3). existingRoleCodes backs both the "uses existing
  // role" / "will create role" hint and the create-only blank-role
  // suggestion — one Set built once per render rather than per keystroke.
  const existingRoleCodes = new Set(vialRoles.map(r => r.code))
  const trimmedFulfillmentRole = form.fulfillment_role.trim()
  const matchedVialRole = trimmedFulfillmentRole
    ? vialRoles.find(r => r.code === trimmedFulfillmentRole)
    : undefined
  const suggestedRoleCode = suggestRoleCode(form.key || form.name, existingRoleCodes)

  // Task 8: "Suggest from methods" — member service ids (selectedOrder) →
  // their distinct default_method_id set → the resolved method rows → one
  // formatted line per method, joined '; '. Pure client-side derivation, no
  // new endpoint; recomputed each render off state already loaded for the
  // membership editor above. Walked in selectedOrder (not allServices' own
  // order) so the suggested line follows the same row order that becomes
  // sort_order on save — the printed COA section order.
  const memberDefaultMethodIds = [
    ...new Set(
      selectedOrder
        .map(id => allServices.find(s => s.id === id)?.default_method_id)
        .filter((id): id is number => id != null)
    ),
  ]
  const suggestedMethods = memberDefaultMethodIds
    .map(id => allMethods.find(m => m.id === id))
    .filter((m): m is HplcMethod => m != null)
  const suggestedMethodText = suggestedMethods.length
    ? suggestedMethods
        .map(m => `${m.code ?? m.name}${m.technique ? ` — ${m.technique}` : ''}${m.reference ? ` per ${m.reference}` : ''}`)
        .join('; ')
    : null

  // ── Panel helpers ──

  const openCreate = () => {
    setEditingProfile(null)
    setForm(DEFAULT_FORM)
    setAllServices([])
    setAllMethods([])
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
      analytical_vials: profile.analytical_vials != null ? String(profile.analytical_vials) : '',
      sort_order: String(profile.sort_order),
      active: profile.active,
      coa_section_title: profile.coa_section_title ?? '',
      coa_archetype: profile.coa_archetype,
      coa_sort_order: String(profile.coa_sort_order),
      coa_basis_note: profile.coa_basis_note ?? '',
      coa_method_text: profile.coa_method_text ?? '',
      coa_prep_text: profile.coa_prep_text ?? '',
      coa_footnotes: profile.coa_footnotes ?? [],
      role_boxable: false,
      fulfillment_role: profile.fulfillment_role ?? '',
      fulfillment_dim: profile.fulfillment_dim,
      sla_tier_id: profile.sla_tier_id,
      // Not on AnalysisProfileResponse (see FormState's doc comment) — the
      // department Select only matters for a role this save might newly
      // mint, so it always starts unset on open, same as create.
      role_department_id: null,
    })
    setMemberSearch('')
    setPanelOpen(true)

    // member_ids on the list response is already sort_order-ordered, but it
    // can be up to 5min stale (useAnalysisProfiles' staleTime) — fetch fresh
    // membership here so Save Members can't silently revert a concurrent
    // edit made since the list last loaded. Ride hosts have no such stale
    // echo on the list response at all, so they're always fetched fresh too.
    setLoadingMembers(true)
    setLoadingRideHosts(true)
    try {
      // getMethods is best-effort here (.catch → []): it only feeds the
      // "Suggest from methods" button, and must never turn a methods-catalog
      // hiccup into a full membership-load failure for this panel.
      const [services, memberIds, hosts, methods] = await Promise.all([
        getAnalysisServices(),
        getAnalysisProfileMembers(profile.id),
        getRideHosts(profile.id),
        getMethods().catch(() => []),
      ])
      setAllServices(services)
      setSelectedOrder(memberIds)
      setRideHosts(hosts)
      setAllMethods(methods)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load membership data')
    } finally {
      setLoadingMembers(false)
      setLoadingRideHosts(false)
    }
  }

  const closePanel = () => {
    setPanelOpen(false)
    setEditingProfile(null)
    setForm(DEFAULT_FORM)
    setAllServices([])
    setAllMethods([])
    setSelectedOrder([])
    setRideHosts([])
  }

  // Fills the coa_method_text field from suggestedMethodText — never
  // auto-applied, only on click, and always replaces whatever is there
  // (the authored-override contract from Task 6 is otherwise unchanged).
  const applySuggestedMethodText = () => {
    if (!suggestedMethodText) return
    setForm(f => ({ ...f, coa_method_text: suggestedMethodText }))
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
    if (fulfillmentRoleInvalid) {
      toast.error(FULFILLMENT_ROLE_ERROR)
      return
    }
    setSaving(true)
    try {
      // Auto-mint (Task 3), CREATE only: a blank role with dim=='role' fills
      // in the suggested code rather than sending null. On EDIT, a blank
      // role is left alone — Core/AccuShield-style existing profiles
      // legitimately ride an existing vial with dim=='role' and no role of
      // their own (product_registry.py), and saving unrelated fields on one
      // of those must not retroactively mint it a role.
      const roleForPayload =
        !editingProfile && form.fulfillment_dim === 'role' && !trimmedFulfillmentRole
          ? suggestedRoleCode
          : (trimmedFulfillmentRole || null)

      // Footnotes: drop rows where BOTH sides are blank (never-filled-in
      // rows added then abandoned), but keep a row with only one side
      // filled — trimmed, not silently discarded — so the backend's 400 on
      // a malformed row (blank label or text) surfaces to the admin instead
      // of quietly losing half their input.
      const cleanedFootnotes = form.coa_footnotes
        .filter(row => row.label.trim() !== '' || row.text.trim() !== '')
        .map(row => ({ label: row.label.trim(), text: row.text.trim() }))

      if (editingProfile) {
        await updateAnalysisProfile(editingProfile.id, {
          name: form.name.trim(),
          description: form.description.trim() || null,
          is_addon: form.is_addon,
          vials_required: parseInt(form.vials_required, 10) || 0,
          analytical_vials: form.analytical_vials.trim() === '' ? null : (parseInt(form.analytical_vials, 10) || null),
          sort_order: parseInt(form.sort_order, 10) || 0,
          active: form.active,
          coa_section_title: form.coa_section_title.trim() || null,
          coa_archetype: form.coa_archetype,
          coa_sort_order: parseInt(form.coa_sort_order, 10) || 0,
          coa_basis_note: form.coa_basis_note.trim() || null,
          coa_method_text: form.coa_method_text.trim() || null,
          coa_prep_text: form.coa_prep_text.trim() || null,
          coa_footnotes: cleanedFootnotes.length ? cleanedFootnotes : null,
          fulfillment_role: roleForPayload,
          fulfillment_dim: form.fulfillment_dim,
          sla_tier_id: form.sla_tier_id,
          role_department_id: form.role_department_id,
        })
        toast.success(`"${form.name.trim()}" updated`)
      } else {
        await createAnalysisProfile({
          key: form.key.trim(),
          name: form.name.trim(),
          description: form.description.trim() || null,
          is_addon: form.is_addon,
          vials_required: parseInt(form.vials_required, 10) || 0,
          analytical_vials: form.analytical_vials.trim() === '' ? null : (parseInt(form.analytical_vials, 10) || null),
          sort_order: parseInt(form.sort_order, 10) || 0,
          fulfillment_role: roleForPayload,
          fulfillment_dim: form.fulfillment_dim,
          // Inert until the profile is armed with a later PATCH — see the
          // COA Section block's create-mode note. coa_archetype is NOT sent:
          // the backend 400s on it at create, deliberately.
          coa_section_title: form.coa_section_title.trim() || null,
          coa_sort_order: parseInt(form.coa_sort_order, 10) || 0,
          coa_basis_note: form.coa_basis_note.trim() || null,
          coa_method_text: form.coa_method_text.trim() || null,
          coa_prep_text: form.coa_prep_text.trim() || null,
          coa_footnotes: cleanedFootnotes.length ? cleanedFootnotes : null,
          role_department_id: form.role_department_id,
          role_boxable: form.role_boxable,
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

  // ── COA footnotes (Task 6) ── part of the main form state (not a
  // separate save action like Members/Ride Hosts above) — these ride along
  // in handleSave's payload, same as coa_section_title.

  const addFootnote = () => {
    setForm(f => ({ ...f, coa_footnotes: [...f.coa_footnotes, { label: '', text: '' }] }))
  }

  const removeFootnote = (index: number) => {
    setForm(f => ({ ...f, coa_footnotes: f.coa_footnotes.filter((_, i) => i !== index) }))
  }

  const updateFootnote = (index: number, patch: Partial<{ label: string; text: string }>) => {
    setForm(f => ({
      ...f,
      coa_footnotes: f.coa_footnotes.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }))
  }

  const moveFootnote = (index: number, direction: -1 | 1) => {
    setForm(f => {
      const target = index + direction
      const indexRow = f.coa_footnotes[index]
      const targetRow = f.coa_footnotes[target]
      if (!indexRow || !targetRow) return f
      const next = [...f.coa_footnotes]
      next[index] = targetRow
      next[target] = indexRow
      return { ...f, coa_footnotes: next }
    })
  }

  // ── Ride hosts (spec 4) ──

  const addRideHost = (code: string) => {
    setRideHosts(prev => (prev.includes(code) ? prev : [...prev, code]))
  }

  const removeRideHost = (code: string) => {
    setRideHosts(prev => prev.filter(c => c !== code))
  }

  const moveRideHost = (index: number, direction: -1 | 1) => {
    setRideHosts(prev => {
      const target = index + direction
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const temp = next[index]!
      next[index] = next[target]!
      next[target] = temp
      return next
    })
  }

  const handleSaveRideHosts = async () => {
    if (!editingProfile) return
    setSavingRideHosts(true)
    try {
      const result = await putRideHosts(editingProfile.id, rideHosts)
      toast.success(`Ride hosts saved — ${result.count} host${result.count !== 1 ? 's' : ''}`)
    } catch (err) {
      // Surfaces the backend's 400 text verbatim (e.g. "role 'endo' may not
      // be a ride host...") — extractErrorMessage (api.ts) already unwraps
      // the FastAPI {detail: "..."} body into err.message.
      toast.error(err instanceof Error ? err.message : 'Failed to save ride hosts')
    } finally {
      setSavingRideHosts(false)
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

  // Ride-host add options: never endo/ster/xtra (sensitive tests never
  // share a vial with an unrelated result — client-side echo of the
  // backend's _RIDE_HOST_FORBIDDEN, same idiom as FULFILLMENT_ROLE_PATTERN),
  // never the profile's own role (can't ride itself), never one already on
  // the list (avoid a duplicate-add the PUT would 500 on).
  const RIDE_HOST_FORBIDDEN = new Set(['endo', 'ster', 'xtra'])
  const rideHostOptions = vialRoles.filter(r =>
    !RIDE_HOST_FORBIDDEN.has(r.code) &&
    r.code !== editingProfile?.fulfillment_role &&
    !rideHosts.includes(r.code)
  )

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
        <div className="flex items-center gap-2">
          <NewTestOnboardingGuide />
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />
            Add Profile
          </Button>
        </div>
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
                    <label className="text-sm font-medium">Analytical Vials</label>
                    <Input
                      type="number"
                      min={1}
                      placeholder="all"
                      value={form.analytical_vials}
                      onChange={e => setForm(f => ({ ...f, analytical_vials: e.target.value }))}
                      className="max-w-[120px]"
                    />
                    <p className="text-[11px] text-muted-foreground max-w-[160px]">
                      Of the required vials, how many carry analyses. Blank =
                      all. Heavy metals: ship 2, pool into 1 digest → set 1;
                      the rest become material vials (custody only).
                    </p>
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

                {/* Fulfillment — which vial this profile's results land on.
                    Shown on create AND edit (unlike active/COA below): a new
                    family needs this from day one to be UI-manageable
                    end-to-end, not just via a follow-up edit. */}
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <label className="text-sm font-medium">Fulfillment</label>
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-default" />
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs">
                          <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                            <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                              Vial fulfillment
                            </div>
                            <div>
                              <span className="font-semibold">Role</span> matches by vial role code (e.g. <span className="font-mono">hm</span>).
                            </div>
                            <div>
                              <span className="font-semibold">Kind</span> matches by assignment kind instead.
                            </div>
                            <div className="pt-1 opacity-80">
                              Empty role rides an existing vial rather than claiming its own.
                            </div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <div className="flex gap-4">
                    <div className="space-y-1.5">
                      <Select
                        value={form.fulfillment_dim}
                        onValueChange={v =>
                          setForm(f => ({ ...f, fulfillment_dim: v as 'role' | 'kind' }))
                        }
                      >
                        <SelectTrigger className="w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="role">Role</SelectItem>
                          <SelectItem value="kind">Kind</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Input
                        placeholder="e.g. hm"
                        value={form.fulfillment_role}
                        maxLength={8}
                        aria-invalid={fulfillmentRoleInvalid}
                        onChange={e =>
                          setForm(f => ({ ...f, fulfillment_role: e.target.value.toLowerCase() }))
                        }
                        className="font-mono max-w-[160px]"
                      />
                    </div>
                  </div>
                  <p className={fulfillmentRoleInvalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                    {fulfillmentRoleInvalid
                      ? FULFILLMENT_ROLE_ERROR
                      : 'vial role code, ≤ 8 chars, e.g. hm — leave empty for profiles that ride an existing vial'}
                  </p>

                  {/* Auto-mint hint (Task 3) — only meaningful once the
                      format is valid and dim=='role'. Three states: typed
                      code matches the vial_roles catalog already (reused,
                      untouched); typed code doesn't (will mint on save, so
                      offer a department up front); field is blank on the
                      CREATE panel (offer the suggested code that Save will
                      fill in). Suppressed on EDIT when blank — an existing
                      profile's blank role is a real "rides an existing
                      vial" state (e.g. Core/AccuShield), and Save does NOT
                      auto-mint one for it, so no hint implying it would. */}
                  {!fulfillmentRoleInvalid && form.fulfillment_dim === 'role' && (
                    <>
                      {trimmedFulfillmentRole && matchedVialRole && (
                        <p className="text-xs text-muted-foreground">
                          Uses existing role &lsquo;{matchedVialRole.code}&rsquo; — {matchedVialRole.label}
                        </p>
                      )}
                      {trimmedFulfillmentRole && !matchedVialRole && (
                        <div className="space-y-1.5">
                          <p className="text-xs text-muted-foreground">
                            Will create role &lsquo;{trimmedFulfillmentRole}&rsquo;
                          </p>
                          <Select
                            // No "none" sentinel item: '' is a real "nothing
                            // selected yet" state to Radix (shouldShowPlaceholder
                            // treats '' the same as undefined), so the
                            // placeholder renders immediately — a controlled
                            // sentinel ITEM value would only resolve to
                            // visible text after SelectContent has mounted
                            // once (i.e. after the admin opens it), which
                            // reads as blank on first render. Staying a
                            // string (not undefined) keeps the component
                            // controlled from the first render, same as
                            // coa_archetype's `?? 'none'` a few fields down.
                            value={form.role_department_id !== null ? String(form.role_department_id) : ''}
                            onValueChange={v => setForm(f => ({ ...f, role_department_id: Number(v) }))}
                          >
                            <SelectTrigger className="w-48 h-8 text-xs" aria-label="Role department">
                              <SelectValue placeholder="No department yet" />
                            </SelectTrigger>
                            <SelectContent>
                              {departments.map(dep => (
                                <SelectItem key={dep.id} value={String(dep.id)}>
                                  {dep.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {/* Boxable rides the same auto-mint-only contract as
                              the department Select above: it configures the
                              role THIS save mints, so it only shows when one
                              will actually be minted. An existing role is
                              re-configured on the Vial Roles page instead —
                              roles can be shared by several profiles. */}
                          <div className="flex items-center gap-2 pt-1">
                            <Checkbox
                              id="role-boxable"
                              checked={form.role_boxable}
                              onCheckedChange={checked =>
                                setForm(f => ({ ...f, role_boxable: checked === true }))
                              }
                            />
                            <label htmlFor="role-boxable" className="text-xs leading-none">
                              Boxable
                              <span className="block text-[11px] font-normal text-muted-foreground">
                                Vials in this role appear in the boxing flow.
                              </span>
                            </label>
                          </div>
                        </div>
                      )}
                      {!trimmedFulfillmentRole && !editingProfile && (
                        <p className="text-xs text-muted-foreground">
                          Leave blank to auto-create &lsquo;{suggestedRoleCode}&rsquo;
                        </p>
                      )}
                    </>
                  )}
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
                        Inactive marks the profile retired — fulfilment of already-sold orders continues. Removing it from sale is the WordPress Test-Services entry.
                      </span>
                    </label>
                  </div>
                )}

                {/* COA section wiring. Title/order are settable at CREATE —
                    they are inert until the profile is armed, so configuring
                    them up front costs nothing. The archetype Select stays
                    EDIT-only: arming applies retroactively (rule A2 refuses
                    the COA of any in-flight sample missing a result), so it
                    is a deliberate second act, and the backend 400s on
                    coa_archetype at create to say so out loud. */}
                <div className="space-y-4 border-t pt-4">
                  {editingProfile && (
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
                  )}
                  {!editingProfile && (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">COA Section</span> — the profile
                      is created <span className="font-medium">not reported</span>. Set these now if
                      you like; they take effect when you turn on certificate reporting from the edit
                      panel.
                    </p>
                  )}

                    <div className="flex gap-4">
                      <div className="flex-1 space-y-1.5">
                        <label className="text-sm font-medium">Section Title</label>
                        <Input
                          placeholder={form.name || 'Section title'}
                          value={form.coa_section_title}
                          // On EDIT the archetype gates its own parameters. On
                          // CREATE there is no archetype to pick yet, so the
                          // fields stay open — the note above explains that
                          // they are dormant until reporting is turned on.
                          disabled={!!editingProfile && form.coa_archetype === null}
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

                {/* COA display copy (Task 6) — basis note / method / prep
                    text and footnotes, printed on the certificate for this
                    section. Same "settable at CREATE, inert until archetype
                    armed" contract as Section Title/Order above. */}
                <div className="space-y-4 border-t pt-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <label htmlFor="coa-basis-note" className="text-sm font-medium">
                        Basis Note
                      </label>
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
                                Short qualifier printed under the section heading — e.g. the basis for pass/fail limits.
                              </div>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <Input
                      id="coa-basis-note"
                      placeholder="e.g. Limits per USP <232>"
                      value={form.coa_basis_note}
                      onChange={e =>
                        setForm(f => ({ ...f, coa_basis_note: e.target.value }))
                      }
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <label htmlFor="coa-method-text" className="text-sm font-medium">
                          Method
                        </label>
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
                                <div>Test method printed on the certificate for this section.</div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={!suggestedMethodText}
                        title={
                          suggestedMethodText
                            ? undefined
                            : 'No member service resolves to a default method — assign default methods to member services first'
                        }
                        onClick={applySuggestedMethodText}
                      >
                        Suggest from methods
                      </Button>
                    </div>
                    <Textarea
                      id="coa-method-text"
                      className="min-h-[72px]"
                      placeholder="e.g. ICP-MS"
                      value={form.coa_method_text}
                      onChange={e =>
                        setForm(f => ({ ...f, coa_method_text: e.target.value }))
                      }
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <label htmlFor="coa-prep-text" className="text-sm font-medium">
                        Prep
                      </label>
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
                              <div>Sample preparation printed on the certificate for this section.</div>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <Textarea
                      id="coa-prep-text"
                      className="min-h-[72px]"
                      placeholder="e.g. Microwave digestion"
                      value={form.coa_prep_text}
                      onChange={e =>
                        setForm(f => ({ ...f, coa_prep_text: e.target.value }))
                      }
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <label className="text-sm font-medium">Footnotes</label>
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
                                  Printed below the section, in list order. Both label and text are required per row on save — a half-filled row is kept and rejected by the backend rather than silently dropped.
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <Button type="button" size="sm" variant="outline" onClick={addFootnote}>
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        Add Footnote
                      </Button>
                    </div>

                    {form.coa_footnotes.length === 0 ? (
                      <p className="py-2 text-xs text-muted-foreground">No footnotes.</p>
                    ) : (
                      <div className="space-y-2">
                        {form.coa_footnotes.map((footnote, index) => (
                          <div key={index} className="flex gap-2 rounded-md border p-2">
                            <div className="flex-1 space-y-1.5">
                              <Input
                                aria-label={`Footnote ${index + 1} label`}
                                placeholder="Label"
                                value={footnote.label}
                                onChange={e => updateFootnote(index, { label: e.target.value })}
                              />
                              <Textarea
                                aria-label={`Footnote ${index + 1} text`}
                                className="min-h-[52px] text-xs"
                                placeholder="Footnote text"
                                value={footnote.text}
                                onChange={e => updateFootnote(index, { text: e.target.value })}
                              />
                            </div>
                            <div className="flex flex-col gap-0.5 shrink-0">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                disabled={index === 0}
                                aria-label={`Move footnote ${index + 1} up`}
                                onClick={() => moveFootnote(index, -1)}
                              >
                                <ChevronUp className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                disabled={index === form.coa_footnotes.length - 1}
                                aria-label={`Move footnote ${index + 1} down`}
                                onClick={() => moveFootnote(index, 1)}
                              >
                                <ChevronDown className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-destructive hover:text-destructive"
                                aria-label={`Remove footnote ${index + 1}`}
                                onClick={() => removeFootnote(index)}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* SLA tier (Task 11) — edit only. Beats the member services'
                    group tier, loses to a priority override. Inheriting the
                    group SLA (the pre-Task-11 default) is the "— inherit
                    group SLA —" option, not a tier to pick. */}
                {editingProfile && (
                  <div className="space-y-1.5 border-t pt-4">
                    <div className="flex items-center gap-1.5">
                      <label className="text-sm font-medium">SLA Tier</label>
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3.5 w-3.5 text-muted-foreground cursor-default" />
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-xs">
                            <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                              <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                                SLA precedence
                              </div>
                              <div>
                                A profile tier beats its member services&rsquo; group tier, but a priority override (e.g. expedited) still wins over both.
                              </div>
                              <div>
                                <span className="font-semibold">— inherit group SLA —</span> — no profile-level tier; falls back to the group tier (or the catch-all default).
                              </div>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <Select
                      value={form.sla_tier_id != null ? String(form.sla_tier_id) : 'inherit'}
                      onValueChange={v =>
                        setForm(f => ({ ...f, sla_tier_id: v === 'inherit' ? null : Number(v) }))
                      }
                    >
                      <SelectTrigger className="w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit">— inherit group SLA —</SelectItem>
                        {slaTiers.map(t => (
                          <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                                ? 'No analysis services found. Create them on the Analysis Services page first.'
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

              {/* Ride hosts editor (spec 4) — only when editing an existing
                  profile, same edit-only gating as Members/COA above. */}
              {editingProfile && (
                <div className="border-t pt-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <h3 className="text-sm font-semibold">Ride Hosts</h3>
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3.5 w-3.5 text-muted-foreground cursor-default" />
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-xs">
                            <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                              <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                                Ride lists
                              </div>
                              <div>
                                Priority order — this profile's result attaches to the first host role below that already has a live vial.
                              </div>
                              <div>
                                Falls back to minting its own vial when none of these hosts are ordered.
                              </div>
                              <div className="pt-1 opacity-80">
                                endo, ster, and xtra can never be a ride host — sensitive tests never share a vial.
                              </div>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleSaveRideHosts}
                      disabled={savingRideHosts || loadingRideHosts}
                    >
                      {savingRideHosts && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                      Save Ride Hosts
                    </Button>
                  </div>

                  {loadingRideHosts ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <>
                      {/* Selected — priority ordered */}
                      <div className="space-y-1.5">
                        <p className="text-xs text-muted-foreground">
                          {rideHosts.length === 0
                            ? 'No ride hosts — mints its own vial'
                            : `${rideHosts.length} host${rideHosts.length !== 1 ? 's' : ''}, priority order`}
                        </p>
                        <div className="max-h-40 overflow-y-auto rounded-md border divide-y">
                          {rideHosts.length === 0 ? (
                            <p className="py-4 text-center text-sm text-muted-foreground">
                              No ride hosts configured.
                            </p>
                          ) : (
                            rideHosts.map((code, index) => {
                              const role = vialRoles.find(r => r.code === code)
                              return (
                                <div
                                  key={code}
                                  className="flex items-center gap-3 px-3 py-2"
                                >
                                  <Badge variant="secondary" className="w-6 justify-center shrink-0 font-mono text-[10px]">
                                    {index + 1}
                                  </Badge>
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium truncate font-mono">{code}</div>
                                    {role?.label && (
                                      <div className="text-xs text-muted-foreground truncate">
                                        {role.label}
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-0.5 shrink-0">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      disabled={index === 0}
                                      aria-label={`Move ${code} up`}
                                      onClick={() => moveRideHost(index, -1)}
                                    >
                                      <ChevronUp className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      disabled={index === rideHosts.length - 1}
                                      aria-label={`Move ${code} down`}
                                      onClick={() => moveRideHost(index, 1)}
                                    >
                                      <ChevronDown className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6 text-destructive hover:text-destructive"
                                      aria-label={`Remove ${code} ride host`}
                                      onClick={() => removeRideHost(code)}
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

                      {/* Add — select from the vial-roles catalog, already
                          excluding endo/ster/xtra, this profile's own role,
                          and codes already on the list. */}
                      <div className="space-y-1.5">
                        <Select
                          value=""
                          onValueChange={v => addRideHost(v)}
                          disabled={rideHostOptions.length === 0}
                        >
                          <SelectTrigger className="w-56 h-8 text-xs" aria-label="Add ride host">
                            <SelectValue
                              placeholder={
                                rideHostOptions.length === 0
                                  ? 'No eligible roles'
                                  : 'Add a ride host role...'
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {rideHostOptions.map(r => (
                              <SelectItem key={r.code} value={r.code}>
                                {r.code} — {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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
