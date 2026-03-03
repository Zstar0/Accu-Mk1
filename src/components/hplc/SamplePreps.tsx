import { useState, useEffect, useCallback } from 'react'
import { ClipboardList, Search, Plus, RefreshCw, ChevronRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { listSamplePreps, getWizardSession, updateSamplePrep, type SamplePrep } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { useWizardStore } from '@/store/wizard-store'

const STATUSES: { value: string; label: string; cls: string }[] = [
  { value: 'awaiting_hplc', label: 'Awaiting HPLC', cls: 'bg-blue-600 text-white' },
  { value: 'completed',     label: 'Completed',     cls: 'bg-green-600 text-white' },
  { value: 'on_hold',       label: 'On Hold',       cls: 'bg-amber-500 text-white' },
  { value: 'review',        label: 'Review',        cls: 'bg-purple-600 text-white' },
]


function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtNum(val: number | null, decimals = 2, unit = '') {
  if (val == null) return '—'
  return `${val.toFixed(decimals)}${unit ? ' ' + unit : ''}`
}

export function SamplePreps() {
  const navigateTo = useUIStore(state => state.navigateTo)

  const [preps, setPreps] = useState<SamplePrep[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [openingId, setOpeningId] = useState<number | null>(null)
  const [updatingStatusId, setUpdatingStatusId] = useState<number | null>(null)

  const load = useCallback(async (q?: string) => {
    setLoading(true)
    setError(null)
    try {
      const data = await listSamplePreps({ search: q || undefined, limit: 100 })
      setPreps(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sample preps')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      load(searchInput || undefined)
    }, 400)
    return () => clearTimeout(t)
  }, [searchInput, load])

  async function openInWizard(prep: SamplePrep) {
    if (openingId != null) return
    if (!prep.wizard_session_id) {
      alert(`Sample prep ${prep.sample_id} has no linked wizard session to edit.`)
      return
    }
    setOpeningId(prep.id)
    try {
      const session = await getWizardSession(prep.wizard_session_id)
      useWizardStore.getState().startSession(session)
      useWizardStore.getState().setCurrentStep(3)
      navigateTo('hplc-analysis', 'new-analysis')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load wizard session')
    } finally {
      setOpeningId(null)
    }
  }

  async function changeStatus(prep: SamplePrep, newStatus: string) {
    setUpdatingStatusId(prep.id)
    try {
      const updated = await updateSamplePrep(prep.id, { status: newStatus })
      setPreps(prev => prev.map(p => p.id === prep.id ? { ...p, status: updated.status } : p))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status')
    } finally {
      setUpdatingStatusId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6 h-full">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-primary" />
            Sample Preps
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Completed HPLC sample preparation records saved to Integration-Services.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => load(searchInput || undefined)}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => navigateTo('hplc-analysis', 'new-analysis')}
          >
            <Plus className="h-4 w-4 mr-1.5" />
            New Prep
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          id="sample-preps-search"
          placeholder="Search by ID, SENAITE ID, peptide…"
          className="pl-9"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
        />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Table */}
      {!error && (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Sample ID</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">SENAITE ID</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Peptide</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Declared Wt.</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Target Conc.</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actual Conc.</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {loading && preps.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : preps.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                    No sample preps found.{' '}
                    <button
                      className="underline text-primary"
                      onClick={() => navigateTo('hplc-analysis', 'new-analysis')}
                    >
                      Start a new prep
                    </button>
                    .
                  </td>
                </tr>
              ) : (
                preps.map(prep => (
                  <tr
                    key={prep.id}
                    className="border-b hover:bg-muted/40 cursor-pointer transition-colors"
                    onClick={() => openInWizard(prep)}
                  >
                    <td className="px-4 py-3 font-mono font-medium">{prep.sample_id}</td>
                    <td className="px-4 py-3 text-muted-foreground">{prep.senaite_sample_id ?? '—'}</td>
                    <td className="px-4 py-3">
                      {prep.peptide_abbreviation
                        ? <span className="font-medium">{prep.peptide_abbreviation}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {fmtNum(prep.declared_weight_mg, 2, 'mg')}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {fmtNum(prep.target_conc_ug_ml, 1, 'ug/mL')}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {fmtNum(prep.actual_conc_ug_ml, 2, 'ug/mL')}
                    </td>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <div className="relative">
                        {updatingStatusId === prep.id && (
                          <Loader2 className="absolute right-1 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-muted-foreground" />
                        )}
                        <select
                          value={prep.status}
                          disabled={updatingStatusId === prep.id}
                          onChange={e => changeStatus(prep, e.target.value)}
                          className="appearance-none rounded-full px-2 py-0.5 text-xs font-medium border-0 cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
                          style={{
                            backgroundColor: STATUSES.find(s => s.value === prep.status)?.cls.includes('blue') ? 'rgb(37 99 235)'
                              : STATUSES.find(s => s.value === prep.status)?.cls.includes('green') ? 'rgb(22 163 74)'
                              : STATUSES.find(s => s.value === prep.status)?.cls.includes('amber') ? 'rgb(245 158 11)'
                              : STATUSES.find(s => s.value === prep.status)?.cls.includes('purple') ? 'rgb(147 51 234)'
                              : 'transparent',
                            color: 'white',
                          }}
                        >
                          {STATUSES.map(s => (
                            <option key={s.value} value={s.value} style={{ background: '#1f2937', color: 'white' }}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(prep.created_at)}</td>
                    <td className="px-4 py-3">
                      {openingId === prep.id
                        ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {!loading && `${preps.length} record${preps.length !== 1 ? 's' : ''} shown`}
      </p>
    </div>
  )
}
