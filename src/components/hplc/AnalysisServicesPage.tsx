import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  Search,
  RefreshCw,
  FlaskConical,
  ChevronRight,
  Plus,
  Trash2,
  Info,
  X,
} from 'lucide-react'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
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
  getDepartments,
  getPeptides,
  syncAnalysisServices,
  updateAnalysisServicePeptide,
  type AnalysisServiceRecord,
  type AnalysisServiceCreatePayload,
  type AnalysisServiceUpdatePayload,
  type Department,
  type PeptideRecord,
} from '@/lib/api'
import {
  useCreateAnalysisService,
  useUpdateAnalysisService,
  useDeleteAnalysisService,
} from '@/services/analysis-services'
import { ResultOptionsEditor, type ResultOption } from './ResultOptionsEditor'
import { ServiceSpecsSection } from './ServiceSpecsSection'

export function AnalysisServicesPage() {
  const [services, setServices] = useState<AnalysisServiceRecord[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [peptides, setPeptides] = useState<PeptideRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [syncing, setSyncing] = useState(false)

  const deleteMutation = useDeleteAnalysisService()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [svcData, deptData, pepData] = await Promise.all([
        getAnalysisServices(),
        getDepartments(),
        getPeptides(),
      ])
      setServices(svcData)
      setDepartments(deptData)
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

  const openCreate = () => {
    setSelectedId(null)
    setCreating(true)
  }

  const openRow = (id: number) => {
    setCreating(false)
    setSelectedId(id)
  }

  const closePanel = () => {
    setCreating(false)
    setSelectedId(null)
  }

  const handleSaved = useCallback(async () => {
    await load()
    closePanel()
  }, [load])

  const handleDeleteService = (svc: AnalysisServiceRecord) => {
    if (!window.confirm(`Delete "${svc.title}"? This cannot be undone.`)) return
    deleteMutation.mutate(svc.id, {
      onSuccess: async () => {
        await load()
        if (selectedId === svc.id) closePanel()
      },
    })
  }

  const selectedService = creating ? null : (services.find(s => s.id === selectedId) ?? null)
  const panelOpen = creating || !!selectedService

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
              Lab tests synced from Senaite LIMS, plus Mk1-native services
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />
            New Service
          </Button>
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
              <TableHead>Origin</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-20"></TableHead>
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
                  {services.length === 0
                    ? 'No analysis services yet. Click "Sync from Senaite" or "New Service".'
                    : 'No services match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(svc => (
                <TableRow
                  key={svc.id}
                  className={`cursor-pointer transition-colors hover:bg-muted/50 ${
                    selectedId === svc.id && !creating ? 'bg-muted/50' : ''
                  }`}
                  onClick={() => openRow(svc.id)}
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
                    <div className="flex items-center gap-1">
                      <Badge variant={svc.origin === 'mk1' ? 'default' : 'outline'} className="text-xs">
                        {svc.origin === 'mk1' ? 'Mk1' : 'SENAITE'}
                      </Badge>
                      {svc.origin === 'senaite' && !!svc.local_overrides?.length && (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="secondary" className="text-[10px] cursor-default">
                                {svc.local_overrides.length} overridden
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs">
                              <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                                <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                                  Locally overridden fields
                                </div>
                                <div>Sync no longer controls: {svc.local_overrides.join(', ')}</div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={svc.active ? 'default' : 'outline'} className="text-xs">
                      {svc.active ? 'Active' : 'Inactive'}
                    </Badge>
                    {svc.variance_capable && (
                      <Badge variant="secondary" className="ml-1 text-xs">Variance</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {svc.origin === 'mk1' && (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-destructive hover:text-destructive"
                                disabled={deleteMutation.isPending}
                                onClick={e => { e.stopPropagation(); handleDeleteService(svc) }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="left">Delete this Mk1-native service</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Right slide-out panel — shared by create and edit */}
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
                <FlaskConical className="h-5 w-5 text-primary" />
                <span className="text-lg font-semibold">
                  {creating ? 'New Service' : selectedService!.title}
                </span>
                {!creating && selectedService && (
                  <Badge variant={selectedService.origin === 'mk1' ? 'default' : 'outline'} className="text-xs">
                    {selectedService.origin === 'mk1' ? 'Mk1' : 'SENAITE'}
                  </Badge>
                )}
              </div>
              <Button variant="ghost" size="icon" onClick={closePanel}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <ServicePanel
                key={creating ? 'create' : selectedService!.id}
                service={selectedService}
                departments={departments}
                peptides={peptides}
                onSaved={handleSaved}
                onNoOpSave={closePanel}
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

// ─── Service Create / Edit Panel ───

interface ServiceFormState {
  title: string
  keyword: string
  category: string
  unit: string
  department_id: number | null
  peptide_id: number | null
  result_type: string
  result_options: ResultOption[]
  variance_capable: boolean
  active: boolean
}

function toFormState(service: AnalysisServiceRecord | null): ServiceFormState {
  return {
    title: service?.title ?? '',
    keyword: service?.keyword ?? '',
    category: service?.category ?? '',
    unit: service?.unit ?? '',
    department_id: service?.department_id ?? null,
    peptide_id: service?.peptide_id ?? null,
    result_type: service?.result_type ?? '',
    result_options: service?.result_options ?? [],
    variance_capable: service?.variance_capable ?? false,
    active: service?.active ?? true,
  }
}

/**
 * Matches `assert_keyword_editable`'s 409 wording (backend/main.py) for a
 * keyword change refused because `lims_analyses` already reference this
 * service. There is no boolean on `AnalysisServiceRecord` for "has
 * analyses" — the backend message is the only signal available, so this is
 * the fallback path referenced in the task brief: the field starts
 * editable for Mk1-origin rows and locks reactively once a request
 * "slips through" and gets refused this way.
 */
function isKeywordReferencedError(e: unknown): e is Error {
  return e instanceof Error && e.message.includes('referenced by existing analyses')
}

function ServicePanel({
  service,
  departments,
  peptides,
  onSaved,
  onNoOpSave,
}: {
  service: AnalysisServiceRecord | null
  departments: Department[]
  peptides: PeptideRecord[]
  onSaved: () => void
  /** Edit mode, nothing actually changed: close without a pointless reload
   *  (or a "you saved nothing" toast) — the user asked to be done editing. */
  onNoOpSave: () => void
}) {
  const isCreate = service === null

  // Keyed by service.id/'create' in the parent, so this panel remounts on
  // switch and these initializers re-seed cleanly. No effect — unrelated
  // refetches (Sync, another row's save) must not clobber in-progress edits.
  const [form, setForm] = useState<ServiceFormState>(() => toFormState(service))
  const [keywordLockMessage, setKeywordLockMessage] = useState<string | null>(null)
  const [savingAll, setSavingAll] = useState(false)

  const createMutation = useCreateAnalysisService()
  const updateMutation = useUpdateAnalysisService()

  const hasOptions = form.result_type === 'select' || form.result_type === 'multiselect'
  const isSlotService = /^ANALYTE-\d/i.test(form.keyword)

  const keywordDisabledReason = isCreate
    ? null
    : service!.origin === 'senaite'
      ? 'SENAITE-owned join key — the sync and COABuilder index results off this exact value. Edit it in SENAITE instead.'
      : keywordLockMessage

  // Peptide link is deliberately routed through the dedicated PUT
  // /analysis-services/{id}/peptide endpoint, never through the POST/PATCH
  // body — the POST/PATCH schemas don't even accept `peptide_id`. The PUT is
  // the only endpoint that also maintains `peptide_name` (set on link,
  // cleared on unlink) — routing peptide_id through create/update would
  // leave the Peptide Name column and its search index stale the moment a
  // link changes.
  // Returns whether the link succeeded so the caller can decide whether it's
  // safe to run the rest of the save's success flow.
  const linkPeptide = async (
    id: number,
    peptideId: number | null,
    verb: 'created' | 'saved'
  ): Promise<boolean> => {
    try {
      await updateAnalysisServicePeptide(id, peptideId)
      return true
    } catch (e) {
      toast.error(
        e instanceof Error
          ? `Service ${verb}, but peptide link failed: ${e.message}`
          : `Service ${verb}, but peptide link failed`
      )
      return false
    }
  }

  // Compared RAW (no .trim()) against the raw-seeded form value — the
  // change-detection gate must ask "did the user touch this field", not "is
  // the trimmed value different from the untrimmed stored one". A stored
  // value with incidental whitespace (SENAITE data isn't guaranteed clean)
  // would otherwise register as "changed" on every untouched save, wrongly
  // locking it as a local override / tripping the keyword-immutability
  // guard. Trimming still happens only where the field's *value* is built
  // for the payload, never in the *is it changed* comparison.
  const originalKeyword = service?.keyword ?? ''
  const keywordChanged = !isCreate && form.keyword !== originalKeyword

  const handleSave = async () => {
    if (!form.title.trim()) {
      toast.error('Title is required')
      return
    }
    // Keyword is nullable on SENAITE-origin rows and the field is disabled
    // for them, so it can never be "fixed" to satisfy a blanket required
    // check — only enforce this when a keyword is actually being set
    // (create) or actually being changed (edit).
    if ((isCreate || keywordChanged) && !form.keyword.trim()) {
      toast.error('Keyword is required')
      return
    }

    // Sanitize option rows: trim, drop empty values, dedup by value (first
    // wins). Empty value collides with the result cell's "— Select —"
    // placeholder; duplicates produce duplicate React keys + wrong
    // resolveResultLabel matches; untrimmed " 1 " never matches a stored "1".
    const cleaned = form.result_options
      .map(o => ({ value: o.value.trim(), label: o.label.trim() || o.value.trim() }))
      .filter(o => o.value)
    const deduped = cleaned.filter((o, i) => cleaned.findIndex(x => x.value === o.value) === i)
    const newResultOptions = hasOptions ? deduped : null

    setSavingAll(true)
    try {
      if (isCreate) {
        const payload: AnalysisServiceCreatePayload = {
          title: form.title.trim(),
          keyword: form.keyword.trim(),
          category: form.category.trim() || null,
          unit: form.unit.trim() || null,
          department_id: form.department_id,
          result_type: form.result_type || null,
          result_options: newResultOptions,
          variance_capable: form.variance_capable,
        }
        let created: AnalysisServiceRecord
        try {
          created = await createMutation.mutateAsync(payload)
        } catch {
          return // createMutation's onError already toasted the backend detail
        }
        // The record now exists — always finish the success flow (reload +
        // close) from here on, even if the peptide link sub-step fails.
        // Unlike edit, retrying "Save" here is NOT idempotent: this branch
        // calls createAnalysisService again, which would mint a SECOND
        // service. A failed peptide link is recoverable by reopening the
        // new row in Edit; a duplicate row is not.
        if (form.peptide_id != null) {
          await linkPeptide(created.id, form.peptide_id, 'created')
        }
        onSaved()
      } else {
        // Build the PATCH body from CHANGED fields only, diffed against the
        // persisted record — never an unconditional full-object send. Two
        // regressions came from sending every field on every save: (1) a
        // SENAITE row with a null keyword became entirely unsavable, because
        // the disabled keyword field could never satisfy a blanket
        // "keyword required" guard; (2) result_options was nulled by saves
        // that never touched result type, because result_options only rode
        // along with `hasOptions` (true only for select/multiselect) instead
        // of reflecting whether the stored value actually changed.
        const payload: AnalysisServiceUpdatePayload = {}

        // Each gate compares the RAW form value against the RAW seeded
        // value (see the comment on `keywordChanged` above) — only the
        // payload's VALUE is trimmed/nulled, never the comparison that
        // decides whether the field is included at all.
        if (form.title !== service!.title) payload.title = form.title.trim()

        if (keywordChanged) payload.keyword = form.keyword.trim()

        if (form.category !== (service!.category ?? '')) {
          payload.category = form.category.trim() || null
        }

        if (form.unit !== (service!.unit ?? '')) {
          payload.unit = form.unit.trim() || null
        }

        if (form.department_id !== (service!.department_id ?? null)) {
          payload.department_id = form.department_id
        }

        // result_type/result_options are keyed on user INTENT (did the type
        // actually change?), never on `hasOptions` alone. `hasOptions` is
        // just "is the CURRENT form's type select/multiselect" — computing
        // newResultOptions from it unconditionally and diffing that against
        // storage means an untouched non-select row (which can legitimately
        // have stored result_options — _apply_service_result_type populates
        // them independent of result_type) always "changes" from
        // stored-array to null and gets nulled by ANY unrelated field edit.
        const resultTypeChanged = form.result_type !== (service!.result_type ?? '')
        if (resultTypeChanged) {
          // A deliberate type change legitimately redefines what
          // result_options means here — explicit `null` is correct only in
          // this branch (switching away from select/multiselect clears
          // stale options; switching to one starts from the editor's
          // current contents).
          payload.result_type = form.result_type || null
          payload.result_options = newResultOptions
        } else if (hasOptions) {
          // Type unchanged and currently select/multiselect — only touch
          // result_options if the options themselves differ from storage.
          if (JSON.stringify(newResultOptions) !== JSON.stringify(service!.result_options ?? null)) {
            payload.result_options = newResultOptions
          }
        }
        // else: type unchanged and non-select — never send result_options,
        // regardless of what's stored.

        if (form.variance_capable !== (service!.variance_capable ?? false)) {
          payload.variance_capable = form.variance_capable
        }

        if (form.active !== service!.active) payload.active = form.active

        const peptideChanged = form.peptide_id !== service!.peptide_id

        if (Object.keys(payload).length === 0 && !peptideChanged) {
          onNoOpSave()
          return
        }

        // Skip the PATCH entirely when nothing in it changed — e.g. a
        // peptide-only edit. Firing a no-op PATCH would still succeed and
        // show a technically-true-but-misleading "Analysis service updated"
        // toast before the peptide link (the actual change) is even
        // attempted.
        if (Object.keys(payload).length > 0) {
          try {
            await updateMutation.mutateAsync({ id: service!.id, data: payload })
          } catch (e) {
            if (isKeywordReferencedError(e)) {
              setKeywordLockMessage(e.message)
              setForm(f => ({ ...f, keyword: originalKeyword }))
            }
            return // updateMutation's onError already toasted; keep panel open to retry
          }
        }
        if (peptideChanged) {
          // The primary save already committed (and already toasted). Don't
          // fire the rest of the success flow if only this sub-step fails —
          // closing the panel here would show the OLD peptide under a green
          // "updated" toast with no way to retry. Leaving form.peptide_id
          // untouched means the next Save Changes click retries just this
          // link (the primary fields re-diff to no-ops against the
          // still-stale `service` prop, which is harmless — see fix report).
          const linked = await linkPeptide(service!.id, form.peptide_id, 'saved')
          if (!linked) return
        }
        onSaved()
      }
    } finally {
      setSavingAll(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {/* Title */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            Title <span className="text-destructive">*</span>
          </label>
          <Input
            placeholder="e.g. BPC-157 Purity"
            value={form.title}
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
          />
        </div>

        {/* Keyword */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <label className="text-sm font-medium">
              Keyword <span className="text-destructive">*</span>
            </label>
            {keywordDisabledReason && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground cursor-default" />
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-xs">
                    <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                      <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                        Keyword locked
                      </div>
                      <div>{keywordDisabledReason}</div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <Input
            placeholder="e.g. PURITY_BPC157"
            value={form.keyword}
            disabled={!!keywordDisabledReason}
            onChange={e => setForm(f => ({ ...f, keyword: e.target.value }))}
            className="font-mono"
          />
          {!keywordDisabledReason && (
            <p className="text-xs text-muted-foreground">
              Uppercase letters, digits, "_" and "-"; must start with a letter. Cross-repo join
              key — COABuilder and spec limits index results off this value.
            </p>
          )}
        </div>

        {/* Department — prominent by design: a service with no department is
            silently invisible to bench routing and inbox lanes, and excluded
            from HPLC mirroring. Nullable on the backend, so this is a warning
            affordance, not a hard block. */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <label className="text-sm font-medium">Department</label>
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-default" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs">
                  <div className="flex flex-col gap-1 p-1 text-xs font-mono">
                    <div className="font-semibold border-b border-primary-foreground/20 pb-1">
                      Why this matters
                    </div>
                    <div>Routes results to the correct bench queue and inbox lane.</div>
                    <div>Services with no department are excluded from HPLC mirroring.</div>
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Select
            value={form.department_id != null ? String(form.department_id) : 'none'}
            onValueChange={value =>
              setForm(f => ({ ...f, department_id: value === 'none' ? null : Number(value) }))
            }
          >
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder="Select department…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— None —</SelectItem>
              {[...departments]
                .sort((a, b) => a.sort_order - b.sort_order)
                .map(d => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    {d.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {form.department_id == null && (
            <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
              <AlertCircle className="h-3 w-3 shrink-0" />
              No department — invisible to bench routing and inbox lanes, excluded from HPLC
              mirroring.
            </p>
          )}
        </div>

        {/* Category + Unit */}
        <div className="flex gap-4">
          <div className="space-y-1.5 flex-1">
            <label className="text-sm font-medium">Category</label>
            <Input
              placeholder="e.g. Purity"
              value={form.category}
              onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5 flex-1">
            <label className="text-sm font-medium">Unit</label>
            <Input
              placeholder="e.g. %"
              value={form.unit}
              onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
            />
          </div>
        </div>

        {/* Linked Peptide */}
        <div>
          <label className="mb-1 block text-sm font-medium text-muted-foreground">
            Linked Peptide
          </label>
          {isSlotService ? (
            <p className="text-xs text-muted-foreground italic">
              Generic slot service — peptide resolved per-sample from SENAITE Analyte fields
            </p>
          ) : (
            <Select
              value={form.peptide_id != null ? String(form.peptide_id) : 'none'}
              onValueChange={value =>
                setForm(f => ({ ...f, peptide_id: value === 'none' ? null : Number(value) }))
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

        {!isCreate && (
          <div className="flex items-center gap-3">
            <Checkbox
              id="svc-active"
              checked={form.active}
              onCheckedChange={checked => setForm(f => ({ ...f, active: checked === true }))}
            />
            <label htmlFor="svc-active" className="text-sm font-medium leading-none">
              Active
              <span className="block text-xs font-normal text-muted-foreground">
                Inactive services are hidden from new orders
              </span>
            </label>
          </div>
        )}

        {!isCreate && service!.origin === 'senaite' && (
          <div className="text-xs text-muted-foreground space-y-1">
            <p>
              Editing title, category, or unit on a SENAITE-origin service converts that field to
              a local override — the next sync will leave it alone.
            </p>
            {!!service!.local_overrides?.length && (
              <p>
                Currently overridden:{' '}
                <span className="font-mono">{service!.local_overrides.join(', ')}</span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* Result Type */}
      <div className="border-t pt-4">
        <h4 className="mb-3 text-sm font-semibold text-muted-foreground">Result Type</h4>
        <div className="space-y-3">
          <Select
            value={form.result_type || 'unset'}
            onValueChange={v => setForm(f => ({ ...f, result_type: v === 'unset' ? '' : v }))}
          >
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder="Result type…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unset">— None —</SelectItem>
              <SelectItem value="numeric">Numeric</SelectItem>
              <SelectItem value="select">Select (dropdown)</SelectItem>
              <SelectItem value="multiselect">Multiselect</SelectItem>
              <SelectItem value="string">String</SelectItem>
            </SelectContent>
          </Select>
          {hasOptions && (
            <ResultOptionsEditor
              options={form.result_options}
              onChange={opts => setForm(f => ({ ...f, result_options: opts }))}
            />
          )}
        </div>
      </div>

      {/* Variance Capable */}
      <div className="border-t pt-4">
        <h4 className="mb-3 text-sm font-semibold text-muted-foreground">Variance</h4>
        <div className="flex items-center gap-3">
          <Checkbox
            id="svc-variance"
            checked={form.variance_capable}
            onCheckedChange={checked =>
              setForm(f => ({ ...f, variance_capable: checked === true }))
            }
          />
          <label htmlFor="svc-variance" className="text-sm leading-none">
            Variance-capable (eligible for replicate testing &amp; COA variance series)
          </label>
        </div>
      </div>

      {/* Save */}
      <div className="border-t pt-4 flex justify-end">
        <Button onClick={handleSave} disabled={savingAll}>
          {savingAll && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          {isCreate ? 'Create Service' : 'Save Changes'}
        </Button>
      </div>

      {/* Read-only detail — edit mode only. Condition narrows `service` for
          TS (equivalent to `!isCreate`, since `isCreate = service === null`)
          so this one new line doesn't need a `!` — the rest of the block
          still uses the pre-existing `service!.x` idiom untouched. */}
      {service && (
        <>
          <ServiceSpecsSection serviceId={service.id} peptides={peptides} />

          <div className="border-t pt-4">
            <h4 className="mb-3 text-sm font-semibold text-muted-foreground">
              Methods ({service!.methods?.length ?? 0})
            </h4>
            {!service!.methods || service!.methods.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No methods linked to this service.
              </p>
            ) : (
              <div className="space-y-2">
                {service!.methods.map((m, i) => (
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

          <div className="border-t pt-4 text-xs text-muted-foreground space-y-1">
            {service!.senaite_uid && (
              <div>
                Senaite UID: <span className="font-mono">{service!.senaite_uid}</span>
              </div>
            )}
            {service!.senaite_id && (
              <div>
                Senaite ID: <span className="font-mono">{service!.senaite_id}</span>
              </div>
            )}
            <div>Created: {new Date(service!.created_at).toLocaleString()}</div>
            <div>Updated: {new Date(service!.updated_at).toLocaleString()}</div>
          </div>
        </>
      )}
    </div>
  )
}
