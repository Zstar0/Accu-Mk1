import { useState, useEffect, useRef, Fragment } from 'react'
import { Activity, ArrowDownUp, ArrowUpDown, Check, ChevronDown, ChevronRight, MoreHorizontal, Pencil, X } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { SenaiteAnalysis } from '@/lib/api'
import { useAnalysisEditing, type UseAnalysisEditingReturn } from '@/hooks/use-analysis-editing'
import { useAnalysisTransition, type UseAnalysisTransitionReturn } from '@/hooks/use-analysis-transition'
import { useBulkAnalysisTransition } from '@/hooks/use-bulk-analysis-transition'
import { useSidebar } from '@/components/ui/sidebar'

// --- Status styling constants ---

export const STATUS_COLORS: Record<string, string> = {
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

export const STATUS_LABELS: Record<string, string> = {
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

/** States where an analysis result cell is editable. */
const EDITABLE_STATES = new Set<string | null>(['unassigned', null])

/** Maps review_state to valid transition action names. */
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  unassigned: ['submit', 'reject'],
  to_be_verified: ['retest', 'verify', 'retract', 'reject'],
}

const TRANSITION_LABELS: Record<string, string> = {
  submit: 'Submit',
  retest: 'Retest',
  verify: 'Verify',
  retract: 'Retract',
  reject: 'Reject',
}

const DESTRUCTIVE_TRANSITIONS = new Set(['retract', 'reject'])

// --- Shared components ---

export function StatusBadge({ state }: { state: string }) {
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

// --- Local helpers ---

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
  if (!dateStr) return '\u2014'
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

/** Replace "Analyte N" prefix with the mapped peptide name when available. */
function formatAnalysisTitle(title: string, nameMap: Map<number, string>): { display: string; original: string } {
  const match = title.match(/^Analyte\s+(\d)\s*(.*)/i)
  if (match?.[1]) {
    const slot = parseInt(match[1], 10)
    const suffix = match[2] ?? '' // e.g. "- Purity" or "- Quantity"
    const peptideName = nameMap.get(slot)
    if (peptideName) {
      return { display: `${peptideName} ${suffix}`.trim(), original: title }
    }
  }
  return { display: title, original: title }
}

// --- Retest chain grouping ---

type AnalysisGroup = {
  current: SenaiteAnalysis   // most recent — the COA value
  history: SenaiteAnalysis[] // superseded older entries, oldest first
}

/** Group analyses by title so retest chains collapse under their most recent entry. */
function groupAnalysesByTitle(analyses: SenaiteAnalysis[]): AnalysisGroup[] {
  const groups = new Map<string, SenaiteAnalysis[]>()
  for (const a of analyses) {
    if (!groups.has(a.title)) groups.set(a.title, [])
    groups.get(a.title)!.push(a)
  }
  return Array.from(groups.values()).map(rows => ({
    current: rows[rows.length - 1]!,
    history: rows.slice(0, -1),
  }))
}

// --- Inline edit cell ---

/** Resolves the display label for a result value, mapping through result_options if present. */
function resolveResultLabel(result: string | null, options: SenaiteAnalysis['result_options']): string | null {
  if (!result) return null
  if (options.length > 0) {
    return options.find(o => o.value === result)?.label ?? result
  }
  return result
}

function EditableResultCell({
  analysis,
  editing,
}: {
  analysis: SenaiteAnalysis
  editing: UseAnalysisEditingReturn
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const isEditing = editing.editingUid === analysis.uid
  const canEdit = !!analysis.uid && EDITABLE_STATES.has(analysis.review_state)
  const options = analysis.result_options ?? []
  const hasOptions = options.length > 0
  const displayLabel = resolveResultLabel(analysis.result, options)

  // Auto-focus when entering edit mode
  useEffect(() => {
    if (isEditing) {
      if (hasOptions && selectRef.current) {
        selectRef.current.focus()
      } else if (!hasOptions && inputRef.current) {
        inputRef.current.focus()
        inputRef.current.select()
      }
    }
  }, [isEditing, hasOptions])

  // Editing mode: dropdown for selection-type, text input for free-text
  if (isEditing) {
    return (
      <td className="py-1.5 px-3">
        <div className="flex items-center gap-1.5">
          {hasOptions ? (
            <select
              ref={selectRef}
              value={editing.draft}
              onChange={e => editing.setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { e.preventDefault(); editing.cancelEditing() }
                if (e.key === 'Enter') { e.preventDefault(); if (analysis.uid) void editing.save(analysis.uid) }
              }}
              disabled={editing.isSaving}
              className="h-7 text-sm px-2 py-0 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring shrink-0"
              aria-label={`Select result for ${analysis.title}`}
            >
              <option value="">— Select —</option>
              {options.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          ) : (
            <Input
              ref={inputRef}
              type="text"
              value={editing.draft}
              onChange={e => editing.setDraft(e.target.value)}
              onKeyDown={e => { if (analysis.uid) editing.handleKeyDown(e, analysis.uid) }}
              disabled={editing.isSaving}
              className="h-7 text-sm font-mono px-2 py-1 w-28 shrink-0"
              aria-label={`Edit result for ${analysis.title}`}
            />
          )}
          {analysis.unit && analysis.unit.toLowerCase() !== 'text' && (
            <span className="text-xs text-muted-foreground shrink-0">{analysis.unit}</span>
          )}
          <button
            onClick={() => { if (analysis.uid) void editing.save(analysis.uid) }}
            disabled={editing.isSaving}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
            aria-label="Save"
          >
            {editing.isSaving ? <Spinner className="size-3.5" /> : <Check size={14} />}
          </button>
          <button
            onClick={editing.cancelEditing}
            disabled={editing.isSaving}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50 shrink-0"
            aria-label="Cancel"
          >
            <X size={14} />
          </button>
        </div>
      </td>
    )
  }

  // Display mode: editable (clickable) or read-only
  if (canEdit) {
    return (
      <td className="py-2.5 px-3">
        <button
          onClick={() => { if (analysis.uid) editing.startEditing(analysis.uid, analysis.result) }}
          className="group inline-flex items-center gap-1.5 cursor-pointer rounded-md px-1 -mx-1 py-0.5 -my-0.5 hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Edit result for ${analysis.title}`}
        >
          <span
            className={`text-sm ${hasOptions ? '' : 'font-mono'} ${displayLabel ? 'text-foreground' : 'text-muted-foreground italic'}`}
          >
            {displayLabel || 'Pending'}
          </span>
          <Pencil
            size={12}
            className="text-muted-foreground/40 group-hover:text-muted-foreground transition-colors shrink-0"
          />
        </button>
        {analysis.unit && analysis.unit.toLowerCase() !== 'text' && (
          <span className="text-xs text-muted-foreground ml-1.5">{analysis.unit}</span>
        )}
      </td>
    )
  }

  // Read-only (verified, to_be_verified, etc.)
  return (
    <td className="py-2.5 px-3">
      <span
        className={`text-sm ${hasOptions ? '' : 'font-mono'} ${displayLabel ? 'text-foreground' : 'text-muted-foreground italic'}`}
      >
        {displayLabel || 'Pending'}
      </span>
      {analysis.unit && analysis.unit.toLowerCase() !== 'text' && (
        <span className="text-xs text-muted-foreground ml-1.5">{analysis.unit}</span>
      )}
    </td>
  )
}

// --- History row (superseded retest entry) ---

function HistoryRow({
  analysis,
  analyteNameMap,
}: {
  analysis: SenaiteAnalysis
  analyteNameMap: Map<number, string>
}) {
  const { display, original } = formatAnalysisTitle(analysis.title, analyteNameMap)
  const wasRenamed = display !== original
  return (
    <tr className="border-b border-border/20 bg-muted/10">
      <td className="py-1.5 px-3" />
      <td className="py-1.5 px-3 pl-7">
        <span className="text-xs text-muted-foreground/70" title={wasRenamed ? original : undefined}>
          {display}
          {wasRenamed && (
            <span className="ml-1 text-[10px]">
              ({original.match(/^Analyte\s+\d/i)?.[0]})
            </span>
          )}
        </span>
      </td>
      <td className="py-1.5 px-3">
        <span className="text-xs font-mono text-muted-foreground/60 line-through">
          {resolveResultLabel(analysis.result, analysis.result_options ?? []) || '\u2014'}
        </span>
        {analysis.unit && analysis.unit.toLowerCase() !== 'text' && (
          <span className="text-xs text-muted-foreground/50 ml-1">{analysis.unit}</span>
        )}
      </td>
      <td className="py-1.5 px-3 text-center">
        {analysis.retested ? (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-100/50 text-amber-600/70 dark:bg-amber-500/10 dark:text-amber-500/70">
            Yes
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/50">No</span>
        )}
      </td>
      <td className="py-1.5 px-3 text-xs text-muted-foreground/60">{analysis.method || '\u2014'}</td>
      <td className="py-1.5 px-3 text-xs text-muted-foreground/60">{analysis.instrument || '\u2014'}</td>
      <td className="py-1.5 px-3 text-xs text-muted-foreground/60">{analysis.analyst || '\u2014'}</td>
      <td className="py-1.5 px-3">
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-zinc-100 text-zinc-400 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-500 dark:border-zinc-700">
          Superseded
        </span>
      </td>
      <td className="py-1.5 px-3 text-xs text-muted-foreground/60 whitespace-nowrap">
        {formatDate(analysis.captured)}
      </td>
      <td className="py-1.5 px-3" />
    </tr>
  )
}

// --- Analysis row ---

function AnalysisRow({
  analysis,
  analyteNameMap,
  editing,
  transition,
  selectedUids,
  onToggleSelection,
  isBulkProcessing,
  historyCount,
  isHistoryExpanded,
  onToggleHistory,
}: {
  analysis: SenaiteAnalysis
  analyteNameMap: Map<number, string>
  editing: UseAnalysisEditingReturn
  transition: UseAnalysisTransitionReturn
  selectedUids: Set<string>
  onToggleSelection: (uid: string) => void
  isBulkProcessing: boolean
  historyCount?: number
  isHistoryExpanded?: boolean
  onToggleHistory?: () => void
}) {
  const rowTint = ROW_STATUS_STYLE[analysis.review_state ?? ''] ?? ''
  const { display, original } = formatAnalysisTitle(analysis.title, analyteNameMap)
  const wasRenamed = display !== original
  const allowedTransitions =
    analysis.uid && analysis.review_state
      ? (ALLOWED_TRANSITIONS[analysis.review_state] ?? []).filter(
          t => t !== 'submit' || !!analysis.result
        )
      : []
  const isPending = !!analysis.uid && transition.pendingUids.has(analysis.uid)

  return (
    <tr className={`border-b border-border/50 hover:bg-muted/30 transition-colors ${rowTint}`}>
      <td className="py-2.5 px-3">
        {analysis.uid && (
          <Checkbox
            checked={selectedUids.has(analysis.uid)}
            onCheckedChange={() => { if (analysis.uid) onToggleSelection(analysis.uid) }}
            disabled={isBulkProcessing}
            aria-label={`Select ${analysis.title}`}
          />
        )}
      </td>
      <td className="py-2.5 px-3 text-sm text-foreground font-medium">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span title={wasRenamed ? original : undefined}>
            {display}
            {wasRenamed && (
              <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">
                ({original.match(/^Analyte\s+\d/i)?.[0]})
              </span>
            )}
          </span>
          {!!historyCount && (
            <button
              onClick={onToggleHistory}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted transition-colors cursor-pointer shrink-0"
              title={isHistoryExpanded ? 'Hide previous results' : 'Show previous results'}
            >
              {isHistoryExpanded ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
              {historyCount} prev
            </button>
          )}
        </div>
      </td>
      <EditableResultCell analysis={analysis} editing={editing} />
      <td className="py-2.5 px-3 text-center">
        {analysis.retested ? (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
            Yes
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No</span>
        )}
      </td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground">{analysis.method || '\u2014'}</td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground">{analysis.instrument || '\u2014'}</td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground">{analysis.analyst || '\u2014'}</td>
      <td className="py-2.5 px-3">
        {analysis.review_state && <StatusBadge state={analysis.review_state} />}
      </td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground whitespace-nowrap">
        {formatDate(analysis.captured)}
      </td>
      <td className="py-2 px-3 text-right">
        {analysis.uid && allowedTransitions.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                disabled={isPending}
                className="inline-flex items-center justify-center size-7 rounded-md hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Analysis actions"
              >
                {isPending ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <MoreHorizontal size={14} />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {allowedTransitions.map(t => (
                <DropdownMenuItem
                  key={t}
                  variant={DESTRUCTIVE_TRANSITIONS.has(t) ? 'destructive' : 'default'}
                  onClick={() => {
                    if (!analysis.uid) return
                    if (DESTRUCTIVE_TRANSITIONS.has(t)) {
                      transition.requestConfirm(analysis.uid, t, analysis.title)
                    } else {
                      void transition.executeTransition(analysis.uid, t)
                    }
                  }}
                >
                  {TRANSITION_LABELS[t] ?? t}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </td>
    </tr>
  )
}

// --- Sorting ---

type SortColumn = 'title' | 'result' | 'review_state' | 'analyst' | 'method' | 'instrument' | 'captured'
type SortDir = 'asc' | 'desc'

interface SortConfig { column: SortColumn; dir: SortDir }

function SortableHeader({
  column, label, align = 'left', sortConfig, onSort,
}: {
  column: SortColumn
  label: string
  align?: 'left' | 'center' | 'right'
  sortConfig: SortConfig | null
  onSort: (col: SortColumn) => void
}) {
  const active = sortConfig?.column === column
  const alignClass = align === 'center' ? 'justify-center' : align === 'right' ? 'justify-end' : 'justify-start'
  return (
    <th className={`py-2 px-3 text-${align} text-[11px] font-semibold text-muted-foreground uppercase tracking-wider`}>
      <button
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors ${alignClass}`}
      >
        {label}
        {active
          ? <ArrowDownUp size={11} className="text-foreground shrink-0" />
          : <ArrowUpDown size={11} className="opacity-30 shrink-0" />
        }
      </button>
    </th>
  )
}

function sortGroups(groups: AnalysisGroup[], config: SortConfig, nameMap: Map<number, string>): AnalysisGroup[] {
  return [...groups].sort((a, b) => {
    const aVal = getCellValue(a.current, config.column, nameMap)
    const bVal = getCellValue(b.current, config.column, nameMap)
    const cmp = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' })
    return config.dir === 'asc' ? cmp : -cmp
  })
}

function getCellValue(a: SenaiteAnalysis, col: SortColumn, nameMap: Map<number, string>): string {
  switch (col) {
    case 'title': return formatAnalysisTitle(a.title, nameMap).display
    case 'result': return a.result ?? ''
    case 'review_state': return a.review_state ?? ''
    case 'analyst': return a.analyst ?? ''
    case 'method': return a.method ?? ''
    case 'instrument': return a.instrument ?? ''
    case 'captured': return a.captured ?? ''
  }
}

// --- Main AnalysisTable component ---

interface AnalysisTableProps {
  analyses: SenaiteAnalysis[]
  analyteNameMap: Map<number, string>
  onResultSaved?: (uid: string, newResult: string, newReviewState: string | null) => void
  onTransitionComplete?: () => void
}

export function AnalysisTable({ analyses, analyteNameMap, onResultSaved, onTransitionComplete }: AnalysisTableProps) {
  const [analysisFilter, setAnalysisFilter] = useState<'all' | 'verified' | 'pending' | 'invalid'>('all')
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null)
  const [bulkPendingConfirm, setBulkPendingConfirm] = useState<{ transition: string; count: number } | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [isCardVisible, setIsCardVisible] = useState(true)
  const cardRef = useRef<HTMLDivElement>(null)

  // Show toolbar fixed at bottom while the card is visible; hide when scrolled out of view
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => setIsCardVisible(entry!.isIntersecting),
      { threshold: 0 }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const { open: sidebarOpen } = useSidebar()
  const editing = useAnalysisEditing({ analyses, onResultSaved })
  const transition = useAnalysisTransition({ onTransitionComplete })
  const bulk = useBulkAnalysisTransition({ onTransitionComplete })


  const INVALID_STATES = new Set(['rejected', 'retracted'])
  const invalidCount = analyses.filter(a => INVALID_STATES.has(a.review_state ?? '')).length
  const verifiedCount = analyses.filter(
    a => a.review_state === 'verified' || a.review_state === 'published'
  ).length
  const validCount = analyses.length - invalidCount
  const pendingCount = validCount - verifiedCount
  const progressPct =
    validCount > 0 ? Math.round((verifiedCount / validCount) * 100) : 0

  const filteredAnalyses = analyses.filter(a => {
    if (analysisFilter === 'verified')
      return a.review_state === 'verified' || a.review_state === 'published'
    if (analysisFilter === 'pending')
      return a.review_state !== 'verified' && a.review_state !== 'published' && !INVALID_STATES.has(a.review_state ?? '')
    if (analysisFilter === 'invalid')
      return INVALID_STATES.has(a.review_state ?? '')
    // 'all' — exclude invalid by default, matching SENAITE's "Valid" view
    return !INVALID_STATES.has(a.review_state ?? '')
  })

  const handleSort = (col: SortColumn) => {
    setSortConfig(prev =>
      prev?.column === col
        ? { column: col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { column: col, dir: 'asc' }
    )
  }

  // Group filtered analyses by title so retest chains collapse
  const rawGroups = groupAnalysesByTitle(filteredAnalyses)
  const groups = sortConfig ? sortGroups(rawGroups, sortConfig, analyteNameMap) : rawGroups

  // Header checkbox state — current (COA) rows only
  const selectableUids = groups
    .map(g => g.current.uid)
    .filter((uid): uid is string => !!uid)
  const allSelected =
    selectableUids.length > 0 && selectableUids.every(uid => bulk.selectedUids.has(uid))
  const someSelected = selectableUids.some(uid => bulk.selectedUids.has(uid))
  const headerChecked: boolean | 'indeterminate' =
    allSelected ? true : someSelected ? 'indeterminate' : false

  // Bulk available actions — intersection of ALLOWED_TRANSITIONS for all selected analyses
  const selectedAnalyses = groups
    .filter(g => g.current.uid && bulk.selectedUids.has(g.current.uid))
    .map(g => g.current)
  const bulkAvailableActions = (['submit', 'retest', 'verify', 'retract', 'reject'] as const).filter(t =>
    selectedAnalyses.length > 0 &&
    selectedAnalyses.every(a =>
      a.review_state !== null &&
      a.review_state !== undefined &&
      (ALLOWED_TRANSITIONS[a.review_state] ?? []).includes(t) &&
      (t !== 'submit' || !!a.result)
    )
  )

  // Disable toolbar when any per-row transition is in-flight
  const toolbarDisabled = transition.pendingUids.size > 0

  if (analyses.length === 0) return null

  return (
    <Card ref={cardRef} className="p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground tracking-wide uppercase">
            Analyses
          </span>
          <span className="text-xs text-muted-foreground ml-1">
            {filteredAnalyses.length} of {validCount}
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
              count={validCount}
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
            {invalidCount > 0 && (
              <TabButton
                active={analysisFilter === 'invalid'}
                onClick={() => setAnalysisFilter('invalid')}
                count={invalidCount}
              >
                Invalid
              </TabButton>
            )}
          </div>
        </div>
      </div>

      {/* Progress bar */}
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

      {/* Bulk action toolbar — fixed at browser bottom while table is visible */}
      {bulk.selectedUids.size > 0 && isCardVisible && (
        <div
          className="fixed bottom-4 z-50 flex items-center justify-between px-4 py-2.5 rounded-lg bg-zinc-800 border border-zinc-600 shadow-xl"
          style={{
            left: sidebarOpen
              ? 'calc(50% + var(--sidebar-width) / 2)'
              : 'calc(50% + var(--sidebar-width-icon) / 2)',
            transform: 'translateX(-50%)',
            width: sidebarOpen
              ? 'min(calc(100vw - var(--sidebar-width) - 3rem), 64rem)'
              : 'min(calc(100vw - var(--sidebar-width-icon) - 3rem), 64rem)',
          }}
        >
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-foreground">
              {bulk.selectedUids.size} selected
            </span>
            <button
              onClick={bulk.clearSelection}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 cursor-pointer"
            >
              Clear
            </button>
          </div>
          <div className="flex items-center gap-2">
            {bulk.isBulkProcessing && bulk.bulkProgress ? (
              <div className="flex items-center gap-2">
                <Spinner className="size-3.5" />
                <span className="text-sm text-muted-foreground">
                  {TRANSITION_LABELS[bulk.bulkProgress.transition] ?? bulk.bulkProgress.transition}ing{' '}
                  {bulk.bulkProgress.current}/{bulk.bulkProgress.total}...
                </span>
              </div>
            ) : (
              bulkAvailableActions.map(t => (
                <Button
                  key={t}
                  size="sm"
                  variant={DESTRUCTIVE_TRANSITIONS.has(t) ? 'destructive' : 'default'}
                  disabled={toolbarDisabled}
                  onClick={() => {
                    if (DESTRUCTIVE_TRANSITIONS.has(t)) {
                      setBulkPendingConfirm({ transition: t, count: bulk.selectedUids.size })
                    } else {
                      void bulk.executeBulk([...bulk.selectedUids], t)
                    }
                  }}
                >
                  {TRANSITION_LABELS[t] ?? t} selected
                </Button>
              ))
            )}
            {bulkAvailableActions.length === 0 && !bulk.isBulkProcessing && (
              <span className="text-xs text-muted-foreground italic">
                No common actions for selection
              </span>
            )}
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full">
          <caption className="sr-only">
            Sample analyses and their verification status
          </caption>
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="py-2 px-3 w-10">
                <Checkbox
                  checked={headerChecked}
                  onCheckedChange={(checked) => {
                    if (checked === true) {
                      bulk.selectAll(selectableUids)
                    } else {
                      bulk.clearSelection()
                    }
                  }}
                  disabled={bulk.isBulkProcessing || toolbarDisabled}
                  aria-label="Select all analyses"
                />
              </th>
              <SortableHeader column="title" label="Analysis" sortConfig={sortConfig} onSort={handleSort} />
              <SortableHeader column="result" label="Result" sortConfig={sortConfig} onSort={handleSort} />
              <th className="py-2 px-3 text-center text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Retested
              </th>
              <SortableHeader column="method" label="Method" sortConfig={sortConfig} onSort={handleSort} />
              <SortableHeader column="instrument" label="Instrument" sortConfig={sortConfig} onSort={handleSort} />
              <SortableHeader column="analyst" label="Analyst" sortConfig={sortConfig} onSort={handleSort} />
              <SortableHeader column="review_state" label="Status" sortConfig={sortConfig} onSort={handleSort} />
              <SortableHeader column="captured" label="Captured" sortConfig={sortConfig} onSort={handleSort} />
              <th className="py-2 px-3 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wider w-12">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.length > 0 ? (
              groups.map(group => {
                const groupKey = group.current.uid ?? group.current.title
                const isExpanded = expandedGroups.has(groupKey)
                return (
                  <Fragment key={groupKey}>
                    <AnalysisRow
                      analysis={group.current}
                      analyteNameMap={analyteNameMap}
                      editing={editing}
                      transition={transition}
                      selectedUids={bulk.selectedUids}
                      onToggleSelection={bulk.toggleSelection}
                      isBulkProcessing={bulk.isBulkProcessing}
                      historyCount={group.history.length}
                      isHistoryExpanded={isExpanded}
                      onToggleHistory={() => toggleGroup(groupKey)}
                    />
                    {isExpanded && group.history.map(h => (
                      <HistoryRow
                        key={h.uid ?? h.title}
                        analysis={h}
                        analyteNameMap={analyteNameMap}
                      />
                    ))}
                  </Fragment>
                )
              })
            ) : (
              <tr>
                <td
                  colSpan={10}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  No {analysisFilter === 'all' ? '' : analysisFilter} analyses found
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Per-row destructive transition confirmation */}
        <AlertDialog
          open={transition.pendingConfirm !== null}
          onOpenChange={(open) => {
            if (!open) transition.cancelConfirm()
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {transition.pendingConfirm?.transition === 'retract'
                  ? 'Retract analysis?'
                  : 'Reject analysis?'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                <strong>{transition.pendingConfirm?.analysisTitle}</strong> will be{' '}
                {transition.pendingConfirm?.transition === 'retract'
                  ? 'retracted back to unassigned state'
                  : 'permanently rejected'}
                . This action cannot be undone from this application.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => { void transition.confirmAndExecute() }}
              >
                Confirm {transition.pendingConfirm?.transition}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Bulk destructive transition confirmation */}
      <AlertDialog
        open={bulkPendingConfirm !== null}
        onOpenChange={(open) => { if (!open) setBulkPendingConfirm(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkPendingConfirm?.transition === 'retract'
                ? `Retract ${bulkPendingConfirm.count} analyses?`
                : `Reject ${bulkPendingConfirm?.count} analyses?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {bulkPendingConfirm?.count} analyses will be{' '}
              {bulkPendingConfirm?.transition === 'retract'
                ? 'retracted back to unassigned state'
                : 'permanently rejected'}
              . This action cannot be undone from this application.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (bulkPendingConfirm) {
                  void bulk.executeBulk([...bulk.selectedUids], bulkPendingConfirm.transition)
                }
                setBulkPendingConfirm(null)
              }}
            >
              Confirm {bulkPendingConfirm?.transition}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
