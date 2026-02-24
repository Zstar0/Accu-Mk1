import { useState, useEffect, useId } from 'react'
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
  type LucideIcon,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  lookupSenaiteSample,
  type SenaiteLookupResult,
  type SenaiteAnalysis,
} from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { getSenaiteUrl } from '@/lib/api-profiles'

// --- Local helpers ---

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
      <span
        className={`text-sm text-right ${
          emphasis ? 'font-semibold text-foreground' : 'text-foreground'
        } ${mono ? 'font-mono' : ''}`}
      >
        {value || '—'}
      </span>
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

const STATUS_COLORS: Record<string, string> = {
  verified:
    'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-400 dark:border-emerald-500/20',
  published:
    'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-500/15 dark:text-purple-400 dark:border-purple-500/20',
  to_be_verified:
    'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-500/15 dark:text-orange-400 dark:border-orange-500/20',
  sample_received:
    'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/15 dark:text-blue-400 dark:border-blue-500/20',
  sample_due:
    'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-400 dark:border-rose-500/20',
  sample_registered:
    'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-500/15 dark:text-zinc-400 dark:border-zinc-500/20',
  unassigned:
    'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-500/15 dark:text-zinc-400 dark:border-zinc-500/20',
  assigned:
    'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/20',
  retracted:
    'bg-zinc-100 text-zinc-500 border-zinc-200 dark:bg-zinc-500/15 dark:text-zinc-500 dark:border-zinc-500/20',
  rejected:
    'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-400 dark:border-red-500/20',
  registered:
    'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-400 dark:border-sky-500/20',
  waiting_for_addon_results:
    'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-400 dark:border-indigo-500/20',
  ready_for_review:
    'bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-400 dark:border-cyan-500/20',
}

/** Row-level tint: colored left border + subtle background, inspired by SENAITE. */
const ROW_STATUS_STYLE: Record<string, string> = {
  verified:
    'border-l-2 border-l-blue-500 bg-blue-50/60 dark:bg-blue-500/[0.06]',
  published:
    'border-l-2 border-l-emerald-500 bg-emerald-50/60 dark:bg-emerald-500/[0.06]',
  to_be_verified:
    'border-l-2 border-l-cyan-400 bg-cyan-50/60 dark:bg-cyan-400/[0.06]',
  unassigned:
    'border-l-2 border-l-zinc-300 dark:border-l-zinc-600',
  assigned:
    'border-l-2 border-l-zinc-300 dark:border-l-zinc-600',
  retracted:
    'border-l-2 border-l-orange-400 bg-zinc-100/60 dark:bg-zinc-500/[0.06] italic text-muted-foreground',
  rejected:
    'border-l-2 border-l-zinc-400 bg-zinc-100/60 dark:bg-zinc-500/[0.06]',
  invalid:
    'border-l-2 border-l-orange-600 bg-orange-50/60 dark:bg-orange-500/[0.06]',
  cancelled:
    'border-l-2 border-l-zinc-900 bg-zinc-100/60 dark:border-l-zinc-400 dark:bg-zinc-500/[0.06]',
}

const STATUS_LABELS: Record<string, string> = {
  verified: 'Verified',
  published: 'Published',
  to_be_verified: 'To Verify',
  sample_received: 'Received',
  sample_due: 'Due',
  sample_registered: 'Registered',
  unassigned: 'Unassigned',
  assigned: 'Assigned',
  retracted: 'Retracted',
  rejected: 'Rejected',
  registered: 'Registered',
  waiting_for_addon_results: 'Waiting Addon',
  ready_for_review: 'Ready for Review',
}

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

function StatusBadge({ state }: { state: string }) {
  const color =
    STATUS_COLORS[state] ??
    'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-500/15 dark:text-zinc-400 dark:border-zinc-500/20'
  const label = STATUS_LABELS[state] ?? state.replace(/_/g, ' ')
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${color}`}
    >
      {label}
    </span>
  )
}

function TabButton({
  active,
  children,
  onClick,
  count,
}: {
  active: boolean
  children: React.ReactNode
  onClick: () => void
  count?: number
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active
          ? 'bg-muted text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
      }`}
    >
      {children}
      {count !== undefined && (
        <span
          className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[11px] ${
            active ? 'bg-background/50 text-foreground' : 'bg-muted text-muted-foreground'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  )
}

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

// --- Main Component ---

export function SampleDetails() {
  const sampleId = useUIStore(state => state.sampleDetailsTargetId)
  const navigateTo = useUIStore(state => state.navigateTo)

  const [data, setData] = useState<SenaiteLookupResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [analysisFilter, setAnalysisFilter] = useState<'all' | 'verified' | 'pending'>('all')

  const fetchSample = (id: string) => {
    setLoading(true)
    setError(null)

    lookupSenaiteSample(id)
      .then(result => setData(result))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load sample'))
      .finally(() => setLoading(false))
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
            onClick={() => navigateTo('dashboard', 'senaite')}
          >
            Back to Samples
          </Button>
        </div>
      </div>
    )
  }

  const analyses = data.analyses ?? []
  const verifiedCount = analyses.filter(
    a => a.review_state === 'verified' || a.review_state === 'published'
  ).length
  const pendingCount = analyses.length - verifiedCount
  const progressPct =
    analyses.length > 0 ? Math.round((verifiedCount / analyses.length) * 100) : 0

  const filteredAnalyses = analyses.filter(a => {
    if (analysisFilter === 'verified')
      return a.review_state === 'verified' || a.review_state === 'published'
    if (analysisFilter === 'pending')
      return a.review_state !== 'verified' && a.review_state !== 'published'
    return true
  })

  const senaiteBaseUrl = getSenaiteUrl()

  return (
    <ScrollArea className="h-full">
      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Sticky Action Bar */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground hover:text-foreground cursor-pointer"
              onClick={() => navigateTo('dashboard', 'senaite')}
            >
              <ArrowLeft size={14} />
              Samples
            </Button>
            <ChevronRight size={12} className="text-muted-foreground" />
            <span className="text-sm font-medium">{data.sample_id}</span>
          </div>
          {data.senaite_url && senaiteBaseUrl && (
            <a
              href={`${senaiteBaseUrl}${data.senaite_url}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            >
              <ExternalLink size={13} />
              Open in SENAITE
            </a>
          )}
        </div>

        {/* Header */}
        <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
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
        </div>

        {/* Main Grid: 2-column layout — metadata left, analytes right */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Left column: Sample Info + Order Details stacked */}
          <div className="space-y-4">
            <Card className="p-4">
              <SectionHeader icon={Package} title="Sample Info">
                <div className="space-y-0">
                  <DataRow label="Sample Type" value={data.sample_type} emphasis />
                  <DataRow label="Date Sampled" value={formatDate(data.date_sampled)} />
                  <DataRow label="Date Received" value={formatDate(data.date_received)} />
                  <DataRow
                    label="Declared Qty"
                    value={
                      data.declared_weight_mg != null ? (
                        <span className="font-mono text-emerald-700 dark:text-emerald-400 font-semibold">
                          {data.declared_weight_mg} mg
                        </span>
                      ) : (
                        '—'
                      )
                    }
                    emphasis
                  />
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
                  <DataRow label="Order #" value={data.client_order_number} mono emphasis />
                  <DataRow label="Client Sample ID" value={data.client_sample_id} mono />
                  <DataRow label="Client Lot" value={data.client_lot} mono />
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
          </div>

          {/* Right column: Analytes + COA Info stacked */}
          <div className="space-y-4">
            <Card className="p-4">
              <SectionHeader icon={Layers} title="Analytes">
                {data.analytes.length > 0 ? (
                  <div className="space-y-3">
                    {data.analytes.map((analyte, i) => (
                      <div
                        key={analyte.raw_name + i}
                        className="flex items-center justify-between p-2.5 rounded-lg bg-muted/50 border border-border/30"
                      >
                        <div>
                          <div className="text-sm font-medium text-foreground flex items-center gap-2">
                            <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                              A{i + 1}
                            </span>
                            {analyte.raw_name}
                          </div>
                          {analyte.matched_peptide_name && (
                            <div className="text-[11px] text-muted-foreground mt-0.5">
                              Matched: {analyte.matched_peptide_name}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No analytes defined</p>
                )}
                {data.declared_weight_mg != null && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <DataRow
                      label="Total Declared"
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
                  <DataRow label="Company" value={data.coa.company_name} />
                  <DataRow
                    label="Website"
                    value={
                      data.coa.website ? (
                        <a
                          href={data.coa.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-700 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 flex items-center gap-1 cursor-pointer"
                        >
                          {data.coa.website}
                          <ExternalLink size={10} />
                        </a>
                      ) : (
                        '—'
                      )
                    }
                  />
                  <DataRow label="Email" value={data.coa.email} />
                  <DataRow
                    label="Verification"
                    value={
                      data.coa.verification_code ? (
                        <span className="font-mono text-xs">{data.coa.verification_code}</span>
                      ) : (
                        '—'
                      )
                    }
                  />
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
          </SectionHeader>
        </Card>

        {/* Analyses Table — progress bar integrated here */}
        {analyses.length > 0 && (
          <Card className="p-4 mb-6">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Activity size={15} className="text-muted-foreground" />
                <span className="text-sm font-semibold text-foreground tracking-wide uppercase">
                  Analyses
                </span>
                <span className="text-xs text-muted-foreground ml-1">
                  {filteredAnalyses.length} of {analyses.length}
                </span>
              </div>
              <div
                className="flex items-center gap-2"
                role="tablist"
                aria-label="Filter analyses"
              >
                <div className="flex items-center bg-muted rounded-lg p-0.5 border border-border/50">
                  <TabButton
                    active={analysisFilter === 'all'}
                    onClick={() => setAnalysisFilter('all')}
                    count={analyses.length}
                  >
                    All
                  </TabButton>
                  <TabButton
                    active={analysisFilter === 'verified'}
                    onClick={() => setAnalysisFilter('verified')}
                    count={verifiedCount}
                  >
                    Verified
                  </TabButton>
                  <TabButton
                    active={analysisFilter === 'pending'}
                    onClick={() => setAnalysisFilter('pending')}
                    count={pendingCount}
                  >
                    Pending
                  </TabButton>
                </div>
              </div>
            </div>

            {/* Progress bar — directly above the table */}
            <div className="mb-4">
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-700 ease-out"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="flex justify-between mt-1.5">
                <span className="text-[11px] text-muted-foreground">Analysis Progress</span>
                <span className="text-[11px] text-muted-foreground">{progressPct}% complete</span>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full">
                <caption className="sr-only">
                  Sample analyses and their verification status
                </caption>
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="py-2 px-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Analysis
                    </th>
                    <th className="py-2 px-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Result
                    </th>
                    <th className="py-2 px-3 text-center text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Retested
                    </th>
                    <th className="py-2 px-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Method
                    </th>
                    <th className="py-2 px-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Instrument
                    </th>
                    <th className="py-2 px-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Analyst
                    </th>
                    <th className="py-2 px-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Status
                    </th>
                    <th className="py-2 px-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Captured
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAnalyses.length > 0 ? (
                    filteredAnalyses.map((a, i) => (
                      <AnalysisRow key={`${a.title}-${i}`} analysis={a} />
                    ))
                  ) : (
                    <tr>
                      <td
                        colSpan={8}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        No {analysisFilter === 'all' ? '' : analysisFilter} analyses found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </ScrollArea>
  )
}

// --- Analysis row ---

function AnalysisRow({ analysis }: { analysis: SenaiteAnalysis }) {
  const rowTint = ROW_STATUS_STYLE[analysis.review_state ?? ''] ?? ''
  return (
    <tr className={`border-b border-border/50 hover:bg-muted/30 transition-colors ${rowTint}`}>
      <td className="py-2.5 px-3 text-sm text-foreground font-medium">{analysis.title}</td>
      <td className="py-2.5 px-3">
        <span
          className={`text-sm font-mono ${analysis.result ? 'text-foreground' : 'text-muted-foreground italic'}`}
        >
          {analysis.result || 'Pending'}
        </span>
        {analysis.unit && analysis.unit.toLowerCase() !== 'text' && (
          <span className="text-xs text-muted-foreground ml-1.5">{analysis.unit}</span>
        )}
      </td>
      <td className="py-2.5 px-3 text-center">
        {analysis.retested ? (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
            Yes
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No</span>
        )}
      </td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground">{analysis.method || '—'}</td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground">{analysis.instrument || '—'}</td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground">{analysis.analyst || '—'}</td>
      <td className="py-2.5 px-3">
        {analysis.review_state && <StatusBadge state={analysis.review_state} />}
      </td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground whitespace-nowrap">
        {formatDate(analysis.captured)}
      </td>
    </tr>
  )
}
