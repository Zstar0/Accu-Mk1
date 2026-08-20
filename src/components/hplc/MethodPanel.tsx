import { useState, useEffect, useCallback } from 'react'
import { Loader2, Save, X, Pencil, FlaskConical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { useUIStore } from '@/store/ui-store'
import { toast } from 'sonner'
import {
  updateMethod,
  updatePeptide,
  getInstruments,
  getPeptides,
  getDepartments,
  getAnalysisServices,
  getMethodServices,
  putMethodServices,
  type HplcMethod,
  type PeptideBrief,
  type PeptideRecord,
  type Instrument,
  type Department,
  type AnalysisServiceRecord,
  type MethodServiceLink,
} from '@/lib/api'

interface MethodPanelProps {
  method: HplcMethod
  onUpdated: () => void
}

export function MethodPanel({ method, onUpdated }: MethodPanelProps) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [allPeptides, setAllPeptides] = useState<PeptideRecord[]>([])
  const [assigningPeptide, setAssigningPeptide] = useState(false)
  const [services, setServices] = useState<MethodServiceLink[]>([])
  const [allServices, setAllServices] = useState<AnalysisServiceRecord[]>([])
  const [mutatingServices, setMutatingServices] = useState(false)

  const loadPeptides = useCallback(() => {
    getPeptides().then(setAllPeptides).catch(console.error)
  }, [])

  const loadServices = useCallback(() => {
    getMethodServices(method.id).then(setServices).catch(console.error)
  }, [method.id])

  useEffect(() => {
    getInstruments().then(setInstruments).catch(console.error)
    getDepartments().then(setDepartments).catch(console.error)
    getAnalysisServices().then(setAllServices).catch(console.error)
    loadPeptides()
    loadServices()
  }, [loadPeptides, loadServices])

  // Peptides not yet assigned to this method
  const unassignedPeptides = allPeptides.filter(
    p => !method.common_peptides.some(cp => cp.id === p.id)
  )

  // Analysis services not yet covered by this method
  const unassignedServices = allServices.filter(
    s => !services.some(link => link.analysis_service_id === s.id)
  )

  const putServiceLinks = async (links: { analysis_service_id: number; is_default: boolean }[]) => {
    setMutatingServices(true)
    try {
      const updated = await putMethodServices(method.id, links)
      setServices(updated)
      toast.success('Services updated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update services')
    } finally {
      setMutatingServices(false)
    }
  }

  const handleAddService = (serviceId: number) => {
    const links = [
      ...services.map(l => ({ analysis_service_id: l.analysis_service_id, is_default: l.is_default })),
      { analysis_service_id: serviceId, is_default: false },
    ]
    putServiceLinks(links)
  }

  const handleRemoveService = (serviceId: number) => {
    const links = services
      .filter(l => l.analysis_service_id !== serviceId)
      .map(l => ({ analysis_service_id: l.analysis_service_id, is_default: l.is_default }))
    putServiceLinks(links)
  }

  const handleToggleServiceDefault = (serviceId: number, isDefault: boolean) => {
    const links = services.map(l => ({
      analysis_service_id: l.analysis_service_id,
      is_default: l.analysis_service_id === serviceId ? isDefault : l.is_default,
    }))
    putServiceLinks(links)
  }

  const handleAssignPeptide = async (peptideId: number) => {
    const peptide = allPeptides.find(p => p.id === peptideId)
    if (!peptide) return
    setAssigningPeptide(true)
    try {
      const existingMethodIds = peptide.methods.map(m => m.id)
      await updatePeptide(peptideId, { method_ids: [...existingMethodIds, method.id] })
      toast.success(`Assigned ${peptide.abbreviation}`)
      loadPeptides()
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to assign peptide')
    } finally {
      setAssigningPeptide(false)
    }
  }

  const handleUnassignPeptide = async (peptideId: number) => {
    const peptide = allPeptides.find(p => p.id === peptideId)
    if (!peptide) return
    setAssigningPeptide(true)
    try {
      const newMethodIds = peptide.methods.filter(m => m.id !== method.id).map(m => m.id)
      await updatePeptide(peptideId, { method_ids: newMethodIds })
      toast.success(`Unassigned ${peptide.abbreviation}`)
      loadPeptides()
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to unassign peptide')
    } finally {
      setAssigningPeptide(false)
    }
  }

  // Editable fields
  const [name, setName] = useState(method.name)
  const [code, setCode] = useState(method.code ?? '')
  const [technique, setTechnique] = useState(method.technique ?? '')
  const [departmentId, setDepartmentId] = useState<number | null>(method.department_id ?? null)
  const [reference, setReference] = useState(method.reference ?? '')
  const [procedureSummary, setProcedureSummary] = useState(method.procedure_summary ?? '')
  const [instrumentIds, setInstrumentIds] = useState<number[]>(method.instrument_ids ?? [])
  const [sizePeptide, setSizePeptide] = useState(method.size_peptide ?? '')
  const [startingOrganicPct, setStartingOrganicPct] = useState(
    method.starting_organic_pct?.toString() ?? ''
  )
  const [temperatureMctC, setTemperatureMctC] = useState(
    method.temperature_mct_c?.toString() ?? ''
  )
  const [dissolution, setDissolution] = useState(method.dissolution ?? '')
  const [notes, setNotes] = useState(method.notes ?? '')

  const resetForm = () => {
    setName(method.name)
    setCode(method.code ?? '')
    setTechnique(method.technique ?? '')
    setDepartmentId(method.department_id ?? null)
    setReference(method.reference ?? '')
    setProcedureSummary(method.procedure_summary ?? '')
    setInstrumentIds(method.instrument_ids ?? [])
    setSizePeptide(method.size_peptide ?? '')
    setStartingOrganicPct(method.starting_organic_pct?.toString() ?? '')
    setTemperatureMctC(method.temperature_mct_c?.toString() ?? '')
    setDissolution(method.dissolution ?? '')
    setNotes(method.notes ?? '')
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
      await updateMethod(method.id, {
        name: name.trim(),
        instrument_ids: instrumentIds,
        code: code.trim() || null,
        technique: technique.trim() || null,
        department_id: departmentId,
        reference: reference.trim() || null,
        procedure_summary: procedureSummary.trim() || null,
        size_peptide: sizePeptide.trim() || null,
        starting_organic_pct: startingOrganicPct ? parseFloat(startingOrganicPct) : null,
        temperature_mct_c: temperatureMctC ? parseFloat(temperatureMctC) : null,
        dissolution: dissolution.trim() || null,
        notes: notes.trim() || null,
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
          <h3 className="text-lg font-semibold">{method.name}</h3>
          {method.senaite_id && (
            <p className="text-sm text-muted-foreground">{method.senaite_id}</p>
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

      {/* Method details */}
      {editing ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Method 1" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Code</Label>
              <Input value={code} onChange={e => setCode(e.target.value)} placeholder="AM-ELEM-001" />
            </div>
            <div className="space-y-2">
              <Label>Technique</Label>
              <Input
                value={technique}
                onChange={e => setTechnique(e.target.value)}
                placeholder="ICP-MS"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Department</Label>
              <select
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
            <div className="space-y-2">
              <Label>Reference</Label>
              <Input
                value={reference}
                onChange={e => setReference(e.target.value)}
                placeholder="SOP-1234"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Instruments</Label>
            <div className="space-y-1.5 rounded-md border border-input bg-background px-3 py-2">
              {instruments.map(inst => (
                <label key={inst.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={instrumentIds.includes(inst.id)}
                    onCheckedChange={checked => {
                      setInstrumentIds(prev =>
                        checked
                          ? [...prev, inst.id]
                          : prev.filter(id => id !== inst.id)
                      )
                    }}
                  />
                  {inst.name}
                </label>
              ))}
              {instruments.length === 0 && (
                <span className="text-xs text-muted-foreground">No instruments available</span>
              )}
            </div>
          </div>

          {/* HPLC parameters */}
          <div className="border-t pt-4">
            <h4 className="mb-3 text-sm font-semibold text-muted-foreground">HPLC parameters</h4>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Size Peptide</Label>
                  <Input
                    value={sizePeptide}
                    onChange={e => setSizePeptide(e.target.value)}
                    placeholder="Extremely Polar"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Starting Organic %</Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={startingOrganicPct}
                    onChange={e => setStartingOrganicPct(e.target.value)}
                    placeholder="2"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>MCT Temperature (°C)</Label>
                  <Input
                    type="number"
                    step="1"
                    value={temperatureMctC}
                    onChange={e => setTemperatureMctC(e.target.value)}
                    placeholder="25"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Dissolution</Label>
                  <Input
                    value={dissolution}
                    onChange={e => setDissolution(e.target.value)}
                    placeholder="100% Water"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Procedure Summary</Label>
            <textarea
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={procedureSummary}
              onChange={e => setProcedureSummary(e.target.value)}
              placeholder="Procedure summary..."
            />
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <textarea
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Additional notes..."
            />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Read-only detail grid */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <DetailRow label="Code" value={method.code} />
            <DetailRow label="Technique" value={method.technique} />
            <DetailRow
              label="Department"
              value={departments.find(d => d.id === method.department_id)?.name ?? null}
            />
            <DetailRow label="Reference" value={method.reference} />
            <DetailRow label="Instruments" value={method.instruments.map(i => i.name).join(', ') || null} />
            {method.senaite_id && <DetailRow label="Senaite ID" value={method.senaite_id} />}
          </div>

          {/* HPLC parameters */}
          <div className="border-t pt-4">
            <h4 className="mb-3 text-sm font-semibold text-muted-foreground">HPLC parameters</h4>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <DetailRow label="Size Peptide" value={method.size_peptide} />
              <DetailRow
                label="Starting Organic"
                value={method.starting_organic_pct != null ? `${method.starting_organic_pct}%` : null}
              />
              <DetailRow
                label="MCT Temp"
                value={method.temperature_mct_c != null ? `${method.temperature_mct_c}°C` : null}
              />
              <DetailRow label="Dissolution" value={method.dissolution} />
            </div>
          </div>

          {method.procedure_summary && (
            <div className="text-sm">
              <span className="font-medium text-muted-foreground">Procedure: </span>
              <span>{method.procedure_summary}</span>
            </div>
          )}
          {method.notes && (
            <div className="text-sm">
              <span className="font-medium text-muted-foreground">Notes: </span>
              <span>{method.notes}</span>
            </div>
          )}
        </div>
      )}

      {/* Common Peptides section */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-muted-foreground">
            Assigned Peptides ({method.common_peptides.length})
          </h4>
        </div>
        {method.common_peptides.length === 0 && !editing ? (
          <p className="text-sm text-muted-foreground">
            No peptides assigned to this method yet.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {method.common_peptides.map((p: PeptideBrief) => (
              <div
                key={p.id}
                className="inline-flex items-center gap-1.5 rounded-md border bg-muted/50 px-2.5 py-1 text-sm"
              >
                <button
                  type="button"
                  onClick={() => useUIStore.getState().navigateToPeptide(p.id)}
                  className="inline-flex items-center gap-1.5 transition-colors hover:text-primary"
                >
                  <FlaskConical className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium">{p.abbreviation}</span>
                  <span className="text-muted-foreground">({p.name})</span>
                </button>
                {editing && (
                  <button
                    type="button"
                    onClick={() => handleUnassignPeptide(p.id)}
                    disabled={assigningPeptide}
                    className="ml-1 rounded p-0.5 text-muted-foreground hover:text-destructive transition-colors"
                    title={`Unassign ${p.abbreviation}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {/* Add peptide dropdown — only in edit mode */}
        {editing && unassignedPeptides.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <select
              className="flex h-8 flex-1 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              defaultValue=""
              disabled={assigningPeptide}
              onChange={e => {
                if (e.target.value) {
                  handleAssignPeptide(parseInt(e.target.value, 10))
                  e.target.value = ''
                }
              }}
            >
              <option value="" disabled>Add peptide...</option>
              {unassignedPeptides.map(p => (
                <option key={p.id} value={p.id}>{p.abbreviation} — {p.name}</option>
              ))}
            </select>
            {assigningPeptide && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        )}
      </div>

      {/* Covered Services section */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-muted-foreground">
            Covered Services ({services.length})
          </h4>
        </div>
        {services.length === 0 && !editing ? (
          <p className="text-sm text-muted-foreground">
            No services covered by this method yet.
          </p>
        ) : (
          <div className="space-y-1.5">
            {services.map(link => (
              <div
                key={link.analysis_service_id}
                className="flex items-center gap-2 rounded-md border bg-muted/50 px-2.5 py-1.5 text-sm"
              >
                <span className="font-medium">{link.keyword ?? link.title}</span>
                {link.is_default && !editing && (
                  <Badge variant="secondary" className="text-xs">Default</Badge>
                )}
                {editing && (
                  <div className="ml-auto flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                      <Checkbox
                        checked={link.is_default}
                        disabled={mutatingServices}
                        onCheckedChange={checked =>
                          handleToggleServiceDefault(link.analysis_service_id, checked === true)
                        }
                      />
                      Default
                    </label>
                    <button
                      type="button"
                      onClick={() => handleRemoveService(link.analysis_service_id)}
                      disabled={mutatingServices}
                      className="rounded p-0.5 text-muted-foreground hover:text-destructive transition-colors"
                      title={`Remove ${link.keyword ?? link.title}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {/* Add service dropdown — only in edit mode */}
        {editing && unassignedServices.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <select
              className="flex h-8 flex-1 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              defaultValue=""
              disabled={mutatingServices}
              onChange={e => {
                if (e.target.value) {
                  handleAddService(parseInt(e.target.value, 10))
                  e.target.value = ''
                }
              }}
            >
              <option value="" disabled>Add service...</option>
              {unassignedServices.map(s => (
                <option key={s.id} value={s.id}>{s.keyword ?? s.title}</option>
              ))}
            </select>
            {mutatingServices && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        )}
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
