/**
 * BatchReview component for reviewing samples in a job/batch.
 * Displays all samples with their calculation results in a table format.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty'
import { getJobs, getSamplesWithResults } from '@/lib/api'
import type { Job, SampleWithResults } from '@/lib/api'
import { ClipboardList, FlaskConical, FileSearch } from 'lucide-react'

/**
 * Format status for display with appropriate badge variant.
 */
function StatusBadge({ status }: { status: string }) {
  const variant = {
    pending: 'secondary',
    calculated: 'default',
    approved: 'default',
    rejected: 'destructive',
    error: 'destructive',
  }[status] as 'secondary' | 'default' | 'destructive' | 'outline' | undefined

  const label = {
    pending: 'Pending',
    calculated: 'Calculated',
    approved: 'Approved',
    rejected: 'Rejected',
    error: 'Error',
  }[status] ?? status

  return (
    <Badge variant={variant ?? 'outline'} className="capitalize">
      {label}
    </Badge>
  )
}

/**
 * Format a numeric value for display.
 */
function formatValue(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '-'
  }
  return Number.isInteger(value) ? value.toString() : value.toFixed(4)
}

/**
 * Format a percentage value for display.
 */
function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '-'
  }
  return `${value.toFixed(2)}%`
}

export function BatchReview() {
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null)

  // Fetch available jobs
  const {
    data: jobs,
    isLoading: jobsLoading,
    error: jobsError,
  } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => getJobs(50),
  })

  // Fetch samples with results for selected job
  const {
    data: samples,
    isLoading: samplesLoading,
    error: samplesError,
  } = useQuery({
    queryKey: ['samples-with-results', selectedJobId],
    queryFn: () => {
      if (selectedJobId === null) {
        throw new Error('No job selected')
      }
      return getSamplesWithResults(selectedJobId)
    },
    enabled: selectedJobId !== null,
  })

  // Handle job selection
  const handleJobSelect = (value: string) => {
    setSelectedJobId(Number(value))
  }

  // Format job for display in selector
  const formatJobOption = (job: Job) => {
    const date = new Date(job.created_at).toLocaleDateString()
    return `Job #${job.id} - ${date} (${job.status})`
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardList className="size-5" />
            Batch Review
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Job Selector */}
          <div className="flex items-center gap-4">
            <label htmlFor="job-select" className="text-sm font-medium">
              Select Job:
            </label>
            {jobsLoading ? (
              <div className="flex items-center gap-2">
                <Spinner className="size-4" />
                <span className="text-sm text-muted-foreground">Loading jobs...</span>
              </div>
            ) : jobsError ? (
              <span className="text-sm text-destructive">Failed to load jobs</span>
            ) : jobs && jobs.length > 0 ? (
              <Select onValueChange={handleJobSelect} value={selectedJobId?.toString()}>
                <SelectTrigger id="job-select" className="w-72">
                  <SelectValue placeholder="Select a job to review" />
                </SelectTrigger>
                <SelectContent>
                  {jobs.map(job => (
                    <SelectItem key={job.id} value={job.id.toString()}>
                      {formatJobOption(job)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-sm text-muted-foreground">No jobs available</span>
            )}
          </div>

          {/* Samples Table */}
          {selectedJobId === null ? (
            <Empty className="border py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileSearch />
                </EmptyMedia>
                <EmptyTitle>No Job Selected</EmptyTitle>
                <EmptyDescription>
                  Select a job from the dropdown above to review its samples.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : samplesLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner className="size-8" />
              <span className="ml-2 text-muted-foreground">Loading samples...</span>
            </div>
          ) : samplesError ? (
            <div className="flex items-center justify-center py-12 text-destructive">
              Failed to load samples
            </div>
          ) : samples && samples.length > 0 ? (
            <SamplesTable samples={samples} />
          ) : (
            <Empty className="border py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FlaskConical />
                </EmptyMedia>
                <EmptyTitle>No Samples</EmptyTitle>
                <EmptyDescription>
                  This job has no samples to review.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Table component for displaying samples with results.
 */
function SamplesTable({ samples }: { samples: SampleWithResults[] }) {
  return (
    <ScrollArea className="w-full">
      <div className="min-w-max">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                Filename
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                Status
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                Purity
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                RT
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                Compound
              </th>
            </tr>
          </thead>
          <tbody>
            {samples.map(sample => (
              <tr
                key={sample.id}
                className="border-b last:border-b-0 hover:bg-muted/50"
              >
                <td className="px-3 py-2 font-medium">{sample.filename}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={sample.status} />
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {formatPercent(sample.purity)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {formatValue(sample.retention_time)}
                </td>
                <td className="px-3 py-2">{sample.compound_id ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}
