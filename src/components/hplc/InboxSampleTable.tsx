import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PriorityBadge } from '@/components/hplc/PriorityBadge'
import { AgingTimer } from '@/components/hplc/AgingTimer'
import { StateBadge } from '@/components/senaite/senaite-utils'
import {
  SERVICE_GROUP_COLORS,
  type ServiceGroupColor,
} from '@/lib/service-group-colors'
import type {
  InboxSampleItem,
  InboxPriority,
  WorksheetUser,
} from '@/lib/api'

interface InboxSampleTableProps {
  samples: InboxSampleItem[]
  selectedUids: Set<string>
  onSelectionChange: (uids: Set<string>) => void
  users: WorksheetUser[]
  instruments: { uid: string; title: string }[]
  onPriorityChange: (sampleUid: string, priority: InboxPriority) => void
  onTechAssign: (sampleUids: string[], analystId: number) => void
  onInstrumentAssign: (sampleUids: string[], instrumentUid: string) => void
}

function HeaderCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean
  indeterminate: boolean
  onChange: () => void
}) {
  const checkboxValue = indeterminate ? 'indeterminate' : checked

  return (
    <Checkbox
      checked={checkboxValue}
      onCheckedChange={onChange}
      aria-label="Select all"
    />
  )
}

function ExpandedAnalyses({ sample }: { sample: InboxSampleItem }) {
  if (sample.analyses_by_group.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">No analyses available</p>
    )
  }

  return (
    <div className="space-y-3">
      {sample.analyses_by_group.map(group => {
        const colorKey = (group.group_color as ServiceGroupColor) in SERVICE_GROUP_COLORS
          ? (group.group_color as ServiceGroupColor)
          : 'zinc'
        const colorClasses = SERVICE_GROUP_COLORS[colorKey]

        return (
          <div key={group.group_id}>
            <div className="mb-1.5 flex items-center gap-2">
              <span
                className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${colorClasses}`}
              >
                {group.group_name}
              </span>
            </div>
            <div className="rounded-md border border-border/50 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/40 border-b border-border/50">
                    <th className="px-3 py-1.5 text-start font-medium text-muted-foreground">Analysis</th>
                    <th className="px-3 py-1.5 text-start font-medium text-muted-foreground">Keyword</th>
                    <th className="px-3 py-1.5 text-start font-medium text-muted-foreground">Method</th>
                  </tr>
                </thead>
                <tbody>
                  {group.analyses.map((analysis, idx) => (
                    <tr
                      key={analysis.uid ?? idx}
                      className="border-b border-border/30 last:border-0 hover:bg-muted/20"
                    >
                      <td className="px-3 py-1.5">{analysis.title}</td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground">{analysis.keyword ?? '—'}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{analysis.method ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function InboxSampleTable({
  samples,
  selectedUids,
  onSelectionChange,
  users,
  instruments,
  onPriorityChange,
  onTechAssign,
  onInstrumentAssign,
}: InboxSampleTableProps) {
  const [expandedUids, setExpandedUids] = useState<Set<string>>(new Set())

  const allSelected = samples.length > 0 && selectedUids.size === samples.length
  const someSelected = selectedUids.size > 0 && selectedUids.size < samples.length

  function toggleAll() {
    if (allSelected) {
      onSelectionChange(new Set())
    } else {
      onSelectionChange(new Set(samples.map(s => s.uid)))
    }
  }

  function toggleRow(uid: string) {
    const next = new Set(selectedUids)
    if (next.has(uid)) {
      next.delete(uid)
    } else {
      next.add(uid)
    }
    onSelectionChange(next)
  }

  function toggleExpand(uid: string) {
    const next = new Set(expandedUids)
    if (next.has(uid)) {
      next.delete(uid)
    } else {
      next.add(uid)
    }
    setExpandedUids(next)
  }

  const TOTAL_COLS = 9 // expand + 8 data columns

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8">
            {/* expand toggle header — no action */}
          </TableHead>
          <TableHead className="w-8">
            <HeaderCheckbox
              checked={allSelected}
              indeterminate={someSelected}
              onChange={toggleAll}
            />
          </TableHead>
          <TableHead>Sample ID</TableHead>
          <TableHead>Client</TableHead>
          <TableHead>Priority</TableHead>
          <TableHead>Assigned Tech</TableHead>
          <TableHead>Instrument</TableHead>
          <TableHead>Age</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {samples.map(sample => {
          const isExpanded = expandedUids.has(sample.uid)
          const isSelected = selectedUids.has(sample.uid)

          return (
            <>
              <TableRow
                key={sample.uid}
                data-state={isSelected ? 'selected' : undefined}
              >
                {/* Expand toggle */}
                <TableCell className="w-8 pr-0">
                  <button
                    type="button"
                    onClick={() => toggleExpand(sample.uid)}
                    className="flex items-center justify-center rounded p-0.5 hover:bg-muted/70 transition-colors"
                    aria-label={isExpanded ? 'Collapse row' : 'Expand row'}
                  >
                    <ChevronRight
                      className={`size-4 text-muted-foreground transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
                    />
                  </button>
                </TableCell>

                {/* Checkbox */}
                <TableCell className="w-8">
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleRow(sample.uid)}
                    aria-label={`Select ${sample.id}`}
                  />
                </TableCell>

                {/* Sample ID */}
                <TableCell>
                  <span className="font-mono text-sm">{sample.id}</span>
                </TableCell>

                {/* Client */}
                <TableCell>
                  <span className="text-sm">
                    {sample.client_order_number ?? sample.client_id ?? '—'}
                  </span>
                </TableCell>

                {/* Priority */}
                <TableCell>
                  <Select
                    value={sample.priority}
                    onValueChange={(value) =>
                      onPriorityChange(sample.uid, value as InboxPriority)
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="h-7 min-w-[110px] border-transparent bg-transparent shadow-none hover:border-border focus-visible:border-ring"
                      aria-label="Priority"
                    >
                      <SelectValue>
                        <PriorityBadge priority={sample.priority} />
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">
                        <PriorityBadge priority="normal" />
                      </SelectItem>
                      <SelectItem value="high">
                        <PriorityBadge priority="high" />
                      </SelectItem>
                      <SelectItem value="expedited">
                        <PriorityBadge priority="expedited" />
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>

                {/* Assigned Tech */}
                <TableCell>
                  <Select
                    value={sample.assigned_analyst_id != null ? String(sample.assigned_analyst_id) : ''}
                    onValueChange={(value) =>
                      onTechAssign([sample.uid], Number(value))
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="h-7 min-w-[140px] border-transparent bg-transparent shadow-none hover:border-border focus-visible:border-ring"
                      aria-label="Assigned tech"
                    >
                      <SelectValue placeholder="Assign tech…" />
                    </SelectTrigger>
                    <SelectContent>
                      {users.map(user => (
                        <SelectItem key={user.id} value={String(user.id)}>
                          {user.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>

                {/* Instrument */}
                <TableCell>
                  <Select
                    value={sample.instrument_uid ?? ''}
                    onValueChange={(value) =>
                      onInstrumentAssign([sample.uid], value)
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="h-7 min-w-[140px] border-transparent bg-transparent shadow-none hover:border-border focus-visible:border-ring"
                      aria-label="Instrument"
                    >
                      <SelectValue placeholder="Assign instrument…" />
                    </SelectTrigger>
                    <SelectContent>
                      {instruments.map(inst => (
                        <SelectItem key={inst.uid} value={inst.uid}>
                          {inst.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>

                {/* Age */}
                <TableCell>
                  <AgingTimer dateReceived={sample.date_received} />
                </TableCell>

                {/* Status */}
                <TableCell>
                  <StateBadge state={sample.review_state} />
                </TableCell>
              </TableRow>

              {/* Expanded row */}
              {isExpanded && (
                <TableRow key={`${sample.uid}-expanded`} className="hover:bg-transparent">
                  <TableCell />
                  <TableCell colSpan={TOTAL_COLS - 1} className="bg-muted/30 py-3 px-4 whitespace-normal">
                    <ExpandedAnalyses sample={sample} />
                  </TableCell>
                </TableRow>
              )}
            </>
          )
        })}
      </TableBody>
    </Table>
  )
}
