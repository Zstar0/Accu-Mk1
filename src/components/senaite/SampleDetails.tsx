import { useState, useEffect, useId, useRef } from 'react'
import DOMPurify from 'dompurify'
import {
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Package,
  Hash,
  Layers,
  Shield,
  ShieldCheck,
  MessageSquare,
  Activity,
  User,
  ExternalLink,
  Loader2,
  XCircle,
  ArrowLeft,
  RefreshCw,
  Dna,
  Copy,
  Paperclip,
  ImageIcon,
  Upload,
  Maximize2,
  type LucideIcon,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import {
  lookupSenaiteSample,
  updateSenaiteSampleFields,
  getSampleAdditionalCOAs,
  updateAdditionalCOAConfig,
  fetchSenaiteAttachmentUrl,
  fetchSenaiteAttachmentText,
  uploadSenaiteAttachment,
  getExplorerCOAGenerations,
  generateSenaiteCOA,
  publishSenaiteCOA,
  type SenaiteLookupResult,
  type SenaiteAttachment,
  type SenaiteAttachmentType,
  type AdditionalCOAConfig,
  type ExplorerCOAGeneration,
} from '@/lib/api'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import {
  parseChromatogramCsv,
  downsampleLTTB,
} from '@/components/hplc/ChromatogramChart'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { useUIStore } from '@/store/ui-store'
import { getSenaiteUrl } from '@/lib/api-profiles'
import { EditableDataRow } from '@/components/dashboard/EditableField'
import { AnalysisTable, StatusBadge } from '@/components/senaite/AnalysisTable'

// --- Local helpers ---

function AttachmentImage({ attachment }: { attachment: SenaiteAttachment }) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!attachment.download_url) {
      setError(true)
      setLoading(false)
      return
    }
    let cancelled = false
    fetchSenaiteAttachmentUrl(attachment.uid)
      .then(url => {
        if (!cancelled) setSrc(url)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [attachment.uid, attachment.download_url])

  if (loading) {
    return (
      <div className="flex items-center justify-center w-full h-48 rounded-lg bg-muted/40 border border-border/30">
        <Spinner className="size-5" />
      </div>
    )
  }

  if (error || !src) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 w-full h-48 rounded-lg bg-muted/40 border border-border/30">
        <ImageIcon size={24} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Failed to load image</span>
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={attachment.filename}
      className="rounded-lg border border-border/30 max-h-40 w-auto object-contain"
    />
  )
}

const CHART_SLATE = '#94a3b8'
const CHART_GRID = '#334155'
const CHART_BLUE = '#60a5fa'

function HplcAttachmentChart({ attachment }: { attachment: SenaiteAttachment }) {
  const [chartData, setChartData] = useState<{ t: number; v: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchSenaiteAttachmentText(attachment.uid)
      .then(text => {
        if (cancelled) return
        const raw = parseChromatogramCsv(text)
        const pts = downsampleLTTB(raw, 800)
        if (pts.length > 0) {
          setChartData(pts.map(([t, v]) => ({ t, v })))
        } else {
          setError(true)
        }
      })
      .catch(() => { if (!cancelled) setError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [attachment.uid])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-52 rounded-lg bg-muted/40 border border-border/30">
        <Spinner className="size-5" />
      </div>
    )
  }
  if (error || chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-52 rounded-lg bg-muted/40 border border-border/30">
        <span className="text-xs text-muted-foreground">Failed to parse chromatogram</span>
      </div>
    )
  }

  const chartInner = (tall: boolean) => (
    <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 20, left: tall ? 8 : 4 }}>
      <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
      <XAxis
        dataKey="t"
        type="number"
        domain={['dataMin', 'dataMax']}
        tick={{ fontSize: tall ? 11 : 9, fill: CHART_SLATE }}
        axisLine={{ stroke: CHART_GRID }}
        tickLine={false}
        tickFormatter={(v: number) => v.toFixed(1)}
        label={{ value: 'min', position: 'insideBottom', offset: -10, style: { fontSize: tall ? 11 : 9, fill: CHART_SLATE } }}
      />
      <YAxis
        tick={{ fontSize: tall ? 11 : 9, fill: CHART_SLATE }}
        axisLine={false}
        tickLine={false}
        tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(Math.round(v))}
        width={tall ? 48 : 40}
      />
      <Tooltip
        contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: 6, fontSize: tall ? 12 : 10 }}
        labelStyle={{ color: CHART_SLATE }}
        itemStyle={{ color: '#e2e8f0' }}
        labelFormatter={(v) => `${Number(v).toFixed(3)} min`}
        formatter={(value) => [Number(value).toFixed(2), 'mAU']}
      />
      <Line dataKey="v" dot={false} stroke={CHART_BLUE} strokeWidth={tall ? 2 : 1.5} isAnimationActive={false} />
    </LineChart>
  )

  return (
    <>
      <div className="relative h-52 w-full group">
        <ResponsiveContainer width="100%" height="100%">
          {chartInner(false)}
        </ResponsiveContainer>
        <button
          onClick={() => setExpanded(true)}
          className="absolute top-1.5 right-1.5 p-1 rounded bg-background/60 border border-border/40 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-background/90 transition-all cursor-pointer"
          aria-label="Expand chromatogram"
          title="View full size"
        >
          <Maximize2 size={12} />
        </button>
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-[90vw] sm:max-w-[90vw] w-[90vw]">
          <DialogTitle className="text-sm font-medium truncate pr-6">
            {attachment.filename}
          </DialogTitle>
          <div className="h-[60vh] w-full">
            <ResponsiveContainer width="100%" height="100%">
              {chartInner(true)}
            </ResponsiveContainer>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

const ATTACHMENT_TYPES: SenaiteAttachmentType[] = ['HPLC Graph', 'Sample Image']

const isHplcGraph = (a: SenaiteAttachment) =>
  a.attachment_type === 'HPLC Graph' ||
  a.filename?.toLowerCase().endsWith('.csv') === true

const isRenderable = (a: SenaiteAttachment) =>
  a.content_type?.startsWith('image/') || isHplcGraph(a)

function AddAttachmentForm({
  sampleUid,
  onUploaded,
}: {
  sampleUid: string
  onUploaded: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [attachmentType, setAttachmentType] = useState<SenaiteAttachmentType>('HPLC Graph')
  const [isUploading, setIsUploading] = useState(false)

  const handleUpload = async () => {
    if (!file) return
    setIsUploading(true)
    try {
      const result = await uploadSenaiteAttachment(sampleUid, file, attachmentType)
      if (result.success) {
        toast.success('Attachment uploaded')
        setFile(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
        onUploaded()
      } else {
        toast.error('Upload failed', { description: result.message })
      }
    } catch (err) {
      toast.error('Upload failed', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setIsUploading(false)
    }
  }

  return (
    <div className="pt-3 border-t border-border/40" onClick={e => e.stopPropagation()}>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Add Attachment</p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border bg-muted/40 hover:bg-muted cursor-pointer transition-colors disabled:opacity-50"
        >
          <Paperclip size={13} />
          {file ? file.name : 'Choose file'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={e => setFile(e.target.files?.[0] ?? null)}
          disabled={isUploading}
        />
        <select
          value={attachmentType}
          onChange={e => setAttachmentType(e.target.value as SenaiteAttachmentType)}
          disabled={isUploading}
          className="h-8 text-sm px-2 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {ATTACHMENT_TYPES.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <Button
          size="sm"
          onClick={handleUpload}
          disabled={!file || isUploading}
          className="h-8 gap-1.5"
        >
          {isUploading ? <Spinner className="size-3.5" /> : <Upload size={13} />}
          Upload
        </Button>
      </div>
    </div>
  )
}

function DataRow({
  label,
  value,
  mono = false,
  emphasis = false,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
  emphasis?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between py-1.5 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0 min-w-28 mr-3">{label}</span>
      <div className="flex items-center gap-1">
        <span
          className={`text-sm text-right ${
            emphasis ? 'font-semibold text-foreground' : 'text-foreground'
          } ${mono ? 'font-mono' : ''}`}
        >
          {value || '—'}
        </span>
        {/* Spacer matching the EditableField pencil icon size for column alignment */}
        <span className="inline-block w-[11px] shrink-0" aria-hidden="true" />
      </div>
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  title,
  children,
  defaultOpen = true,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const contentId = useId()
  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex items-center gap-2 w-full text-left group mb-2 cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center justify-center w-6 h-6 rounded-md bg-muted group-hover:bg-muted/80 transition-colors">
          {open ? (
            <ChevronDown size={14} className="text-muted-foreground" />
          ) : (
            <ChevronRight size={14} className="text-muted-foreground" />
          )}
        </div>
        <Icon size={15} className="text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground tracking-wide uppercase">
          {title}
        </span>
      </button>
      {open && <div id={contentId}>{children}</div>}
    </div>
  )
}

// Status styling constants moved to AnalysisTable.tsx

// --- Analysis Profile theming ---

interface ProfileTheme {
  icon: LucideIcon
  bg: string
  text: string
  border: string
}

const PROFILE_THEMES: { pattern: RegExp; theme: ProfileTheme }[] = [
  {
    pattern: /peptide.*(?:single|blend|core)/i,
    theme: {
      icon: FlaskConical,
      bg: 'bg-violet-100 dark:bg-violet-500/15',
      text: 'text-violet-700 dark:text-violet-400',
      border: 'border-violet-200 dark:border-violet-500/20',
    },
  },
  {
    pattern: /endotoxin/i,
    theme: {
      icon: ShieldCheck,
      bg: 'bg-teal-100 dark:bg-teal-500/15',
      text: 'text-teal-700 dark:text-teal-400',
      border: 'border-teal-200 dark:border-teal-500/20',
    },
  },
  {
    pattern: /sterility|pcr/i,
    theme: {
      icon: Dna,
      bg: 'bg-rose-100 dark:bg-rose-500/15',
      text: 'text-rose-700 dark:text-rose-400',
      border: 'border-rose-200 dark:border-rose-500/20',
    },
  },
]

const DEFAULT_PROFILE_THEME: ProfileTheme = {
  icon: Activity,
  bg: 'bg-muted',
  text: 'text-muted-foreground',
  border: 'border-border/50',
}

function getProfileTheme(profileName: string): ProfileTheme {
  for (const { pattern, theme } of PROFILE_THEMES) {
    if (pattern.test(profileName)) return theme
  }
  return DEFAULT_PROFILE_THEME
}

function ProfileChip({ name }: { name: string }) {
  const theme = getProfileTheme(name)
  const Icon = theme.icon
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium border ${theme.bg} ${theme.text} ${theme.border}`}
    >
      <Icon size={12} />
      {name}
    </span>
  )
}

// StatusBadge and TabButton moved to AnalysisTable.tsx

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// --- Add Remark Form ---

function AddRemarkForm({
  sampleUid,
  sampleId,
  onAdded,
}: {
  sampleUid: string
  sampleId: string
  onAdded: () => void
}) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)

  async function handleSubmit() {
    const trimmed = text.trim()
    if (!trimmed) return

    setSaving(true)
    try {
      const result = await updateSenaiteSampleFields(sampleUid, { Remarks: trimmed })
      if (!result.success) throw new Error(result.message)
      toast.success('Remark added')
      setText('')
      setOpen(false)
      onAdded()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      toast.error('Failed to add remark', { description: msg })
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center gap-1.5"
      >
        <MessageSquare size={12} />
        Add remark
      </button>
    )
  }

  return (
    <div className="mt-3 pt-3 border-t border-border space-y-2">
      <Textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Type your remark..."
        disabled={saving}
        className="min-h-15 text-sm"
        aria-label={`Add remark to ${sampleId}`}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
            setText('')
          }
        }}
      />
      <div className="flex items-center gap-2 justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false)
            setText('')
          }}
          disabled={saving}
          className="cursor-pointer"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={saving || !text.trim()}
          className="cursor-pointer gap-1.5"
        >
          {saving && <Spinner className="size-3.5" />}
          Add Remark
        </Button>
      </div>
    </div>
  )
}

// --- Additional COA Card (collapsible) ---

function AdditionalCoaCard({
  coa,
  onUpdateState,
}: {
  coa: AdditionalCOAConfig
  onUpdateState: (field: keyof AdditionalCOAConfig['coa_info'], newValue: string | number | null) => void
}) {
  const [open, setOpen] = useState(false)

  const updateCoaField = (field: keyof AdditionalCOAConfig['coa_info']) =>
    async (newValue: string | number | null) => {
      await updateAdditionalCOAConfig(coa.config_id, {
        [field]: newValue as string | null,
      })
    }

  const updateCoaState = (field: keyof AdditionalCOAConfig['coa_info']) =>
    (newValue: string | number | null) => {
      onUpdateState(field, newValue)
    }

  return (
    <div className="rounded-lg bg-muted/50 border border-border/30">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full p-2.5 cursor-pointer rounded-lg hover:bg-muted/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? (
            <ChevronDown size={13} className="text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight size={13} className="text-muted-foreground shrink-0" />
          )}
          <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
            #{coa.coa_index}
          </span>
          <span className="text-sm font-medium text-foreground truncate">
            {coa.coa_info.company_name || 'Untitled COA'}
          </span>
        </div>
        <Badge
          variant={
            coa.status === 'published'
              ? 'default'
              : coa.status === 'generated'
                ? 'secondary'
                : coa.status === 'failed'
                  ? 'destructive'
                  : 'outline'
          }
          className="text-[10px] shrink-0"
        >
          {coa.status}
        </Badge>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 space-y-1">
          <EditableDataRow
            label="Company"
            value={coa.coa_info.company_name ?? null}
            emphasis
            onSave={updateCoaField('company_name')}
            onSaved={updateCoaState('company_name')}
          />
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0 space-y-0">
              <EditableDataRow
                label="Website"
                value={coa.coa_info.website ?? null}
                onSave={updateCoaField('website')}
                onSaved={updateCoaState('website')}
              />
              <EditableDataRow
                label="Email"
                value={coa.coa_info.email ?? null}
                onSave={updateCoaField('email')}
                onSaved={updateCoaState('email')}
              />
              <EditableDataRow
                label="Address"
                value={coa.coa_info.address ?? null}
                onSave={updateCoaField('address')}
                onSaved={updateCoaState('address')}
              />
              <EditableDataRow
                label="Logo URL"
                value={coa.coa_info.logo_url ?? null}
                truncateStart
                onSave={updateCoaField('logo_url')}
                onSaved={updateCoaState('logo_url')}
              />
              <EditableDataRow
                label="Chromat. BG"
                value={coa.coa_info.chromatograph_background_url ?? null}
                truncateStart
                onSave={updateCoaField('chromatograph_background_url')}
                onSaved={updateCoaState('chromatograph_background_url')}
              />
            </div>
            {(coa.coa_info.logo_url || coa.coa_info.chromatograph_background_url) && (
              <div className="flex items-start gap-2 shrink-0">
                {coa.coa_info.logo_url && (
                  <div className="flex flex-col items-center gap-1">
                    <div className="h-10 w-14 rounded border bg-white flex items-center justify-center overflow-hidden">
                      <img
                        src={coa.coa_info.logo_url}
                        alt={`${coa.coa_info.company_name ?? 'COA'} logo`}
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <span className="text-[9px] text-muted-foreground">Logo</span>
                  </div>
                )}
                {coa.coa_info.chromatograph_background_url && (
                  <div className="flex flex-col items-center gap-1">
                    <div className="h-10 w-14 rounded border bg-white flex items-center justify-center overflow-hidden">
                      <img
                        src={coa.coa_info.chromatograph_background_url}
                        alt="Chromatograph background"
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <span className="text-[9px] text-muted-foreground">Chromat.</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// --- Main Component ---

export function SampleDetails() {
  const sampleId = useUIStore(state => state.sampleDetailsTargetId)
  const navigateTo = useUIStore(state => state.navigateTo)

  const [data, setData] = useState<SenaiteLookupResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [additionalCoas, setAdditionalCoas] = useState<AdditionalCOAConfig[]>([])
  const [coaGenerations, setCoaGenerations] = useState<ExplorerCOAGeneration[]>([])
  const [isGeneratingCOA, setIsGeneratingCOA] = useState(false)
  const [isPublishingCOA, setIsPublishingCOA] = useState(false)
  const [showOlderImages, setShowOlderImages] = useState(false)
  const [showOlderHplc, setShowOlderHplc] = useState(false)

  const fetchSample = (id: string) => {
    setLoading(true)
    setError(null)

    lookupSenaiteSample(id)
      .then(result => setData(result))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load sample'))
      .finally(() => setLoading(false))
  }

  /** Silent re-fetch: updates data without triggering full-page loading state. */
  const refreshSample = (id: string) => {
    lookupSenaiteSample(id)
      .then(result => setData(result))
      .catch(e => toast.error('Refresh failed', { description: e instanceof Error ? e.message : String(e) }))
  }

  useEffect(() => {
    if (!sampleId) return
    let cancelled = false

    setLoading(true)
    setError(null)

    lookupSenaiteSample(sampleId)
      .then(result => {
        if (!cancelled) setData(result)
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load sample')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [sampleId])

  // Fetch additional COAs from integration service
  useEffect(() => {
    if (!sampleId) return
    let cancelled = false

    getSampleAdditionalCOAs(sampleId).then(configs => {
      if (!cancelled) setAdditionalCoas(configs)
    })

    return () => {
      cancelled = true
    }
  }, [sampleId])

  // Fetch COA generations to determine publish availability
  useEffect(() => {
    if (!sampleId) return
    let cancelled = false

    getExplorerCOAGenerations(sampleId, 10).then(gens => {
      if (!cancelled) setCoaGenerations(gens)
    }).catch(() => {})

    return () => {
      cancelled = true
    }
  }, [sampleId])

  if (!sampleId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        No sample selected
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading sample {sampleId}...</p>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 h-full text-muted-foreground">
        <XCircle className="h-8 w-8" />
        <p className="text-sm">{error ?? 'Sample not found'}</p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 cursor-pointer"
            onClick={() => fetchSample(sampleId)}
          >
            <RefreshCw size={14} />
            Retry
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="cursor-pointer"
            onClick={() => navigateTo('senaite', 'samples')}
          >
            Back to Samples
          </Button>
        </div>
      </div>
    )
  }

  const hasDraftCOA = coaGenerations.some(g => g.status === 'draft')

  const handleGenerateCOA = async () => {
    setIsGeneratingCOA(true)
    try {
      const result = await generateSenaiteCOA(sampleId)
      if (result.success) {
        toast.success(result.message || 'COA generation triggered')
        // Populate verification code immediately from the response
        if (result.verification_code) {
          setData(prev =>
            prev ? { ...prev, coa: { ...prev.coa, verification_code: result.verification_code } } : prev
          )
        }
        // Silent refresh to pick up ARReport attachment and other SENAITE state changes
        refreshSample(sampleId)
        getExplorerCOAGenerations(sampleId, 10).then(setCoaGenerations).catch(() => {})
      } else {
        toast.error('COA generation failed', { description: result.message })
      }
    } catch (err) {
      toast.error('COA generation failed', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setIsGeneratingCOA(false)
    }
  }

  const handlePublishCOA = async () => {
    setIsPublishingCOA(true)
    try {
      const result = await publishSenaiteCOA(sampleId)
      if (result.success) {
        toast.success('COA published')
        refreshSample(sampleId)
        getExplorerCOAGenerations(sampleId, 10).then(setCoaGenerations).catch(() => {})
      } else {
        toast.error('COA publish failed', { description: result.message })
      }
    } catch (err) {
      toast.error('COA publish failed', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setIsPublishingCOA(false)
    }
  }

  const analyses = data.analyses ?? []
  const verifiedCount = analyses.filter(
    a => a.review_state === 'verified' || a.review_state === 'published'
  ).length
  const pendingCount = analyses.length - verifiedCount

  const senaiteBaseUrl = getSenaiteUrl()

  // Build a map from slot number → display peptide name
  // e.g. { 1: "BPC-157", 2: "TB-500" }
  const analyteNameMap = new Map<number, string>()
  for (const analyte of data.analytes) {
    const displayName = analyte.matched_peptide_name ?? analyte.raw_name.replace(/\s*-\s*[^-]+\([^)]+\)\s*$/, '')
    analyteNameMap.set(analyte.slot_number, displayName)
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Breadcrumb — scrolls away with the page */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground hover:text-foreground cursor-pointer"
              onClick={() => navigateTo('senaite', 'samples')}
            >
              <ArrowLeft size={14} />
              Samples
            </Button>
            <ChevronRight size={12} className="text-muted-foreground" />
            <span className="text-sm font-medium">{data.sample_id}</span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 cursor-pointer"
                disabled={isGeneratingCOA || isPublishingCOA}
              >
                {(isGeneratingCOA || isPublishingCOA) ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <ChevronDown size={13} />
                )}
                Actions
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem
                onClick={handleGenerateCOA}
                disabled={isGeneratingCOA}
                className="cursor-pointer"
              >
                Generate Accumark COA
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handlePublishCOA}
                disabled={isPublishingCOA || !hasDraftCOA}
                className="cursor-pointer"
              >
                Publish Accumark COA
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Sticky header band — bleeds to container edges with -mx-6 px-6 */}
        <div className="sticky -top-4 z-20 -mx-6 px-6 pt-4 pb-4 mb-6 backdrop-blur-md bg-background/85 border-b border-border/30 shadow-sm">

          {/* Sample ID + counters + progress */}
          <div className="flex items-start justify-between gap-x-4 gap-y-2 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-violet-600/20 to-violet-500/5 border border-violet-500/30 dark:border-violet-500/20">
              <FlaskConical size={20} className="text-violet-600 dark:text-violet-400" />
            </div>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-bold tracking-tight font-mono">
                  {data.senaite_url ? (
                    <a
                      href={`${senaiteBaseUrl}${data.senaite_url}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-blue-700 dark:hover:text-blue-400 transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      {data.sample_id}
                      <ExternalLink size={14} className="text-muted-foreground" />
                    </a>
                  ) : (
                    data.sample_id
                  )}
                </h1>
                {data.review_state && <StatusBadge state={data.review_state} />}
                {data.sample_type && (
                  <Badge
                    variant="outline"
                    className="bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-400 dark:border-violet-500/20"
                  >
                    {data.sample_type}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Received {formatDate(data.date_received)} · Client:{' '}
                <span className="text-foreground/80">{data.client ?? '—'}</span>
              </p>
            </div>
          </div>

          {/* Counters */}
          {analyses.length > 0 && (
            <div className="flex items-center gap-6 text-center">
              <div>
                <div className="text-lg font-bold text-emerald-700 dark:text-emerald-400">
                  {verifiedCount}
                </div>
                <div className="text-[11px] text-muted-foreground uppercase tracking-wider">
                  Verified
                </div>
              </div>
              <div className="w-px h-8 bg-border" />
              <div>
                <div className="text-lg font-bold text-amber-600 dark:text-amber-400">
                  {pendingCount}
                </div>
                <div className="text-[11px] text-muted-foreground uppercase tracking-wider">
                  Pending
                </div>
              </div>
              <div className="w-px h-8 bg-border" />
              <div>
                <div className="text-lg font-bold text-foreground">{analyses.length}</div>
                <div className="text-[11px] text-muted-foreground uppercase tracking-wider">
                  Total
                </div>
              </div>
            </div>
          )}

          {/* Progress bar + legend — w-full forces wrap to bottom row */}
          {analyses.length > 0 && (
            <div className="w-full space-y-1.5">
              <div className="h-1.5 bg-muted/60 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500/70 rounded-full transition-all duration-700"
                  style={{ width: `${(verifiedCount / analyses.length) * 100}%` }}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500/70" />
                    {verifiedCount} Verified
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500/70" />
                    {pendingCount} Pending
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{Math.round((verifiedCount / analyses.length) * 100)}% complete</span>
                  <span className="text-border">·</span>
                  <span>{verifiedCount}/{analyses.length} verified</span>
                </div>
              </div>
            </div>
          )}
          </div>{/* end: sample ID + counters + progress */}
        </div>{/* end: sticky header band */}

        {/* Main Grid: 2-column layout — metadata left, analytes right */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Left column: Sample Info + Order Details stacked */}
          <div className="space-y-4">
            <Card className="p-4">
              <SectionHeader icon={Package} title="Sample Info">
                <div className="space-y-0">
                  <DataRow label="Sample Type" value={data.sample_type} emphasis />
                  <EditableDataRow
                    label="Date Sampled"
                    value={data.date_sampled}
                    senaiteField="DateSampled"
                    sampleUid={data.sample_uid ?? ''}
                    formatDisplay={v => formatDate(v as string)}
                    onSaved={v =>
                      setData(prev =>
                        prev ? { ...prev, date_sampled: v as string | null } : prev
                      )
                    }
                  />
                  <DataRow label="Date Received" value={formatDate(data.date_received)} />
                  <EditableDataRow
                    label="Declared Qty"
                    value={data.declared_weight_mg}
                    senaiteField="DeclaredTotalQuantity"
                    sampleUid={data.sample_uid ?? ''}
                    type="number"
                    mono
                    emphasis
                    suffix="mg"
                    formatDisplay={v =>
                      v != null ? (
                        <span className="font-mono text-emerald-700 dark:text-emerald-400 font-semibold">
                          {v} mg
                        </span>
                      ) : (
                        '—'
                      )
                    }
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? { ...prev, declared_weight_mg: v != null ? Number(v) : null }
                          : prev
                      )
                    }
                  />
                  {/* Verification Code — set by COA Builder after generation */}
                  <div className="flex items-baseline justify-between py-1.5 border-b border-border/50 last:border-0">
                    <span className="text-xs text-muted-foreground shrink-0 min-w-28 mr-3">Verification</span>
                    <div className="flex items-center gap-1 min-w-0">
                      {data.coa.verification_code ? (
                        <span className="text-sm font-mono text-foreground truncate">
                          {data.coa.verification_code}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                      {data.coa.verification_code ? (
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(data.coa.verification_code!)
                            toast.success('Verification code copied')
                          }}
                          className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors cursor-pointer"
                          aria-label="Copy verification code"
                        >
                          <Copy size={11} />
                        </button>
                      ) : (
                        <button
                          onClick={() => refreshSample(sampleId)}
                          className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors cursor-pointer"
                          aria-label="Refresh from SENAITE"
                          title="Check if verification code has been set"
                        >
                          <RefreshCw size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                {data.profiles.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <span className="text-[11px] text-muted-foreground uppercase tracking-wider">
                      Analysis Profiles
                    </span>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {data.profiles.map((p, i) => (
                        <ProfileChip key={p + i} name={p} />
                      ))}
                    </div>
                  </div>
                )}
              </SectionHeader>
            </Card>

            <Card className="p-4">
              <SectionHeader icon={Hash} title="Order Details">
                <div className="space-y-0">
                  <EditableDataRow
                    label="Order #"
                    value={data.client_order_number}
                    senaiteField="ClientOrderNumber"
                    sampleUid={data.sample_uid ?? ''}
                    mono
                    emphasis
                    onSaved={v =>
                      setData(prev =>
                        prev ? { ...prev, client_order_number: v as string | null } : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Client Sample ID"
                    value={data.client_sample_id}
                    senaiteField="ClientSampleID"
                    sampleUid={data.sample_uid ?? ''}
                    mono
                    onSaved={v =>
                      setData(prev =>
                        prev ? { ...prev, client_sample_id: v as string | null } : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Client Lot"
                    value={data.client_lot}
                    senaiteField="ClientLot"
                    sampleUid={data.sample_uid ?? ''}
                    mono
                    onSaved={v =>
                      setData(prev =>
                        prev ? { ...prev, client_lot: v as string | null } : prev
                      )
                    }
                  />
                  <DataRow label="Contact" value={data.contact} />
                  <DataRow
                    label="Client"
                    value={
                      data.client ? (
                        <span className="text-blue-700 dark:text-blue-400 text-xs">
                          {data.client}
                        </span>
                      ) : (
                        '—'
                      )
                    }
                  />
                </div>
              </SectionHeader>
            </Card>

            {/* Additional COAs from Integration Service */}
            {additionalCoas.length > 0 && (
              <Card className="p-4">
                <SectionHeader icon={Copy} title={`Additional COAs (${additionalCoas.length})`}>
                  <div className="space-y-3">
                    {additionalCoas.map(coa => (
                      <AdditionalCoaCard
                        key={coa.config_id}
                        coa={coa}
                        onUpdateState={(field, newValue) =>
                          setAdditionalCoas(prev =>
                            prev.map(c =>
                              c.config_id === coa.config_id
                                ? { ...c, coa_info: { ...c.coa_info, [field]: newValue as string | null } }
                                : c
                            )
                          )
                        }
                      />
                    ))}
                  </div>
                </SectionHeader>
              </Card>
            )}
          </div>

          {/* Right column: Analytes + COA Info stacked */}
          <div className="space-y-4">
            <Card className="p-4">
              <SectionHeader icon={Layers} title="Analytes">
                {data.analytes.length > 0 ? (
                  <div className="space-y-3">
                    {data.analytes.map((analyte) => {
                      const displayName = analyteNameMap.get(analyte.slot_number) ?? analyte.raw_name
                      const slot = analyte.slot_number
                      return (
                        <div
                          key={slot}
                          className="p-2.5 rounded-lg bg-muted/50 border border-border/30 space-y-1"
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                              A{slot}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              Analyte {slot}
                            </span>
                          </div>
                          <div className="[&>div]:border-0 [&>div]:py-1">
                          <EditableDataRow
                            label="Peptide"
                            value={displayName}
                            senaiteField={`Analyte${slot}Peptide`}
                            sampleUid={data.sample_uid ?? ''}
                            onSaved={v =>
                              setData(prev => {
                                if (!prev) return prev
                                const updated = prev.analytes.map(a =>
                                  a.slot_number === slot
                                    ? { ...a, matched_peptide_name: (v as string) ?? a.matched_peptide_name }
                                    : a
                                )
                                return { ...prev, analytes: updated }
                              })
                            }
                          />
                          <EditableDataRow
                            label="Declared Qty"
                            value={analyte.declared_quantity}
                            senaiteField={`Analyte${slot}DeclaredQuantity`}
                            sampleUid={data.sample_uid ?? ''}
                            type="number"
                            mono
                            suffix="mg"
                            onSaved={v =>
                              setData(prev => {
                                if (!prev) return prev
                                const updated = prev.analytes.map(a =>
                                  a.slot_number === slot
                                    ? { ...a, declared_quantity: v != null ? Number(v) : null }
                                    : a
                                )
                                return { ...prev, analytes: updated }
                              })
                            }
                          />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No analytes defined</p>
                )}
                {data.declared_weight_mg != null && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <DataRow
                      label="Total Declared Qty"
                      value={
                        <span className="font-mono text-amber-600 dark:text-amber-400 font-semibold">
                          {data.declared_weight_mg} mg
                        </span>
                      }
                      emphasis
                    />
                  </div>
                )}
              </SectionHeader>
            </Card>

            <Card className="p-4">
              <SectionHeader icon={Shield} title="COA Info">
                <div className="space-y-0">
                  <EditableDataRow
                    label="Company"
                    value={data.coa.company_name}
                    senaiteField="CoaCompanyName"
                    sampleUid={data.sample_uid ?? ''}
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? { ...prev, coa: { ...prev.coa, company_name: v as string | null } }
                          : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Website"
                    value={data.coa.website}
                    senaiteField="CoaWebsite"
                    sampleUid={data.sample_uid ?? ''}
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? { ...prev, coa: { ...prev.coa, website: v as string | null } }
                          : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Email"
                    value={data.coa.email}
                    senaiteField="CoaEmail"
                    sampleUid={data.sample_uid ?? ''}
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? { ...prev, coa: { ...prev.coa, email: v as string | null } }
                          : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Verification"
                    value={data.coa.verification_code}
                    senaiteField="VerificationCode"
                    sampleUid={data.sample_uid ?? ''}
                    mono
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? { ...prev, coa: { ...prev.coa, verification_code: v as string | null } }
                          : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Address"
                    value={data.coa.address}
                    senaiteField="CoaAddress"
                    sampleUid={data.sample_uid ?? ''}
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? { ...prev, coa: { ...prev.coa, address: v as string | null } }
                          : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Logo URL"
                    value={data.coa.company_logo_url}
                    senaiteField="CompanyLogoUrl"
                    sampleUid={data.sample_uid ?? ''}
                    truncateStart
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? { ...prev, coa: { ...prev.coa, company_logo_url: v as string | null } }
                          : prev
                      )
                    }
                  />
                  <EditableDataRow
                    label="Chromatograph BG"
                    value={data.coa.chromatograph_background_url}
                    senaiteField="ChromatographBackgroundUrl"
                    sampleUid={data.sample_uid ?? ''}
                    truncateStart
                    onSaved={v =>
                      setData(prev =>
                        prev
                          ? {
                              ...prev,
                              coa: { ...prev.coa, chromatograph_background_url: v as string | null },
                            }
                          : prev
                      )
                    }
                  />
                  {(data.coa.company_logo_url || data.coa.chromatograph_background_url) && (
                    <div className="py-2 flex items-center gap-3 justify-end">
                      {data.coa.company_logo_url && (
                        <div className="flex flex-col items-center gap-1">
                          <div className="h-16 w-24 rounded border bg-white flex items-center justify-center overflow-hidden">
                            <img
                              src={data.coa.company_logo_url}
                              alt="Company logo"
                              className="max-h-full max-w-full object-contain"
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground">Logo</span>
                        </div>
                      )}
                      {data.coa.chromatograph_background_url && (
                        <div className="flex flex-col items-center gap-1">
                          <div className="h-16 w-24 rounded border bg-white flex items-center justify-center overflow-hidden">
                            <img
                              src={data.coa.chromatograph_background_url}
                              alt="Chromatograph background"
                              className="max-h-full max-w-full object-contain"
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground">Chromatograph</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </SectionHeader>
            </Card>
          </div>
        </div>

        {/* Remarks — full width */}
        <Card className="p-4 mb-6">
          <SectionHeader icon={MessageSquare} title="Remarks">
            {data.remarks.length > 0 ? (
              <div className="space-y-2">
                {data.remarks.map((r, i) => (
                  <div key={`${r.user_id}-${r.created}-${i}`} className="p-3 rounded-lg bg-muted/40 border border-border/30">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center">
                          <User size={11} className="text-muted-foreground" />
                        </div>
                        <span className="text-xs font-medium text-foreground">
                          {r.user_id ?? 'System'}
                        </span>
                      </div>
                      <span className="text-[11px] text-muted-foreground">
                        {formatDate(r.created)}
                      </span>
                    </div>
                    <p
                      className="text-sm text-muted-foreground pl-7 [&_a]:text-blue-700 dark:[&_a]:text-blue-400 [&_a]:underline"
                      dangerouslySetInnerHTML={{
                        __html: DOMPurify.sanitize(r.content, {
                          ALLOWED_TAGS: ['a', 'b', 'i', 'em', 'strong', 'br', 'p', 'span'],
                          ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
                        }),
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No remarks</p>
            )}
            {data.sample_uid && (
              <AddRemarkForm
                sampleUid={data.sample_uid}
                sampleId={data.sample_id}
                onAdded={() => fetchSample(data.sample_id)}
              />
            )}
          </SectionHeader>
        </Card>

        {/* Attachments */}
        <Card className="p-4 mb-6">
          <SectionHeader icon={Paperclip} title={`Attachments (${data.attachments?.length ?? 0})`}>
            <div className="space-y-4">
              {/* Renderable attachments — newest image + newest HPLC graph side by side */}
              {(() => {
                const allImages = (data.attachments ?? []).filter(a => a.content_type?.startsWith('image/'))
                const allHplc = (data.attachments ?? []).filter(isHplcGraph)
                const newestImage = allImages[allImages.length - 1]
                const newestHplc = allHplc[allHplc.length - 1]
                const olderImages = allImages.slice(0, -1)
                const olderHplc = allHplc.slice(0, -1)
                if (!newestImage && !newestHplc) return null

                const renderItem = (attachment: SenaiteAttachment) => (
                  <div key={attachment.uid} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      {attachment.content_type?.startsWith('image/')
                        ? <ImageIcon size={13} className="text-muted-foreground shrink-0" />
                        : <Paperclip size={13} className="text-muted-foreground shrink-0" />}
                      <span className="text-xs font-medium text-foreground truncate">{attachment.filename}</span>
                      {attachment.attachment_type && (
                        <Badge variant="secondary" className="text-[10px] shrink-0">{attachment.attachment_type}</Badge>
                      )}
                    </div>
                    {attachment.content_type?.startsWith('image/')
                      ? <AttachmentImage attachment={attachment} />
                      : <HplcAttachmentChart attachment={attachment} />}
                  </div>
                )

                return (
                  <div className="space-y-3">
                    {/* Newest of each type side by side */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {newestImage && renderItem(newestImage)}
                      {newestHplc && renderItem(newestHplc)}
                    </div>
                    {/* Older images */}
                    {olderImages.length > 0 && (
                      <div>
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setShowOlderImages(v => !v) }}
                          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        >
                          {showOlderImages ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          {olderImages.length} older image{olderImages.length !== 1 ? 's' : ''}
                        </button>
                        {showOlderImages && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                            {olderImages.map(renderItem)}
                          </div>
                        )}
                      </div>
                    )}
                    {/* Older HPLC graphs */}
                    {olderHplc.length > 0 && (
                      <div>
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setShowOlderHplc(v => !v) }}
                          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        >
                          {showOlderHplc ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          {olderHplc.length} older HPLC graph{olderHplc.length !== 1 ? 's' : ''}
                        </button>
                        {showOlderHplc && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                            {olderHplc.map(renderItem)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })()}
              {/* Other file attachments (non-image, non-HPLC) */}
              {data.attachments?.filter(a => !isRenderable(a)).map(attachment => (
                <div key={attachment.uid} className="flex items-center gap-2 p-2 rounded-lg bg-muted/40 border border-border/30">
                  <Paperclip size={14} className="text-muted-foreground shrink-0" />
                  <span className="text-sm text-foreground truncate">{attachment.filename}</span>
                  {attachment.attachment_type && (
                    <Badge variant="secondary" className="text-[10px] shrink-0">
                      {attachment.attachment_type}
                    </Badge>
                  )}
                </div>
              ))}
              {data.sample_uid && (
                <AddAttachmentForm
                  sampleUid={data.sample_uid}
                  onUploaded={() => fetchSample(data.sample_id)}
                />
              )}
            </div>
          </SectionHeader>
        </Card>

        {/* Analyses Table */}
        <AnalysisTable
          analyses={analyses}
          analyteNameMap={analyteNameMap}
          onResultSaved={(uid, newResult, newReviewState) => {
            setData(prev => {
              if (!prev) return prev
              return {
                ...prev,
                analyses: prev.analyses.map(a =>
                  a.uid === uid
                    ? { ...a, result: newResult, review_state: newReviewState ?? a.review_state }
                    : a
                ),
              }
            })
          }}
          onTransitionComplete={() => refreshSample(data.sample_id)}
        />
    </div>
  )
}

