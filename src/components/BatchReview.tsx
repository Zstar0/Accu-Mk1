/**
 * BatchReview component for reviewing samples in a job/batch.
 * Displays all samples with their calculation results in a table format.
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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
import { getJobs, getSamplesWithResults, calculateSample } from '@/lib/api'
import type { Job, SampleWithResults } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { ClipboardList, FlaskConical, FileSearch, Calculator, Loader2 } from 'lucide-react'

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
  const [calculatingIds, setCalculatingIds] = useState<Set<number>>(new Set())
  const queryClient = useQueryClient()

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

  // Mutation for calculating a sample
  const calculateMutation = useMutation({
    mutationFn: calculateSample,
    onSuccess: (result, sampleId) => {
      setCalculatingIds(prev => {
        const next = new Set(prev)
        next.delete(sampleId)
        return next
      })
      queryClient.invalidateQueries({ queryKey: ['samples-with-results', selectedJobId] })
      if (result.failed > 0) {
        toast.warning(`Calculation completed with ${result.failed} error(s)`)
      } else {
        toast.success(`Calculated ${result.successful} formula(s)`)
      }
    },
    onError: (error, sampleId) => {
      setCalculatingIds(prev => {
        const next = new Set(prev)
        next.delete(sampleId)
        return next
      })
      toast.error(`Calculation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    },
  })

  // Handle single sample calculation
  const handleCalculate = (sampleId: number) => {
    setCalculatingIds(prev => new Set(prev).add(sampleId))
    calculateMutation.mutate(sampleId)
  }

  // Handle calculate all pending samples
  const handleCalculateAll = async () => {
    if (!samples) return
    const pendingSamples = samples.filter(s => s.status === 'pending')
    if (pendingSamples.length === 0) {
      toast.info('No pending samples to calculate')
      return
    }

    // Add all pending IDs to calculating set
    setCalculatingIds(new Set(pendingSamples.map(s => s.id)))

    // Calculate each sample
    for (const sample of pendingSamples) {
      try {
        await calculateSample(sample.id)
      } catch {
        // Individual errors handled, continue with others
      }
    }

    // Clear calculating state and refresh
    setCalculatingIds(new Set())
    queryClient.invalidateQueries({ queryKey: ['samples-with-results', selectedJobId] })
    toast.success(`Calculated ${pendingSamples.length} sample(s)`)
  }

  // Handle job selection
  const handleJobSelect = (value: string) => {
    setSelectedJobId(Number(value))
  }

  // Count pending samples
  const pendingCount = samples?.filter(s => s.status === 'pending').length ?? 0
  const isCalculatingAll = calculatingIds.size > 0

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

            {/* Calculate All button */}
            {selectedJobId !== null && pendingCount > 0 && (
              <Button
                onClick={handleCalculateAll}
                disabled={isCalculatingAll}
                variant="outline"
              >
                {isCalculatingAll ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Calculating...
                  </>
                ) : (
                  <>
                    <Calculator className="size-4" />
                    Calculate All ({pendingCount})
                  </>
                )}
              </Button>
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
            <SamplesTable
              samples={samples}
              onCalculate={handleCalculate}
              calculatingIds={calculatingIds}
            />
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
interface SamplesTableProps {
  samples: SampleWithResults[]
  onCalculate: (sampleId: number) => void
  calculatingIds: Set<number>
}

function SamplesTable({ samples, onCalculate, calculatingIds }: SamplesTableProps) {
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
              <th className="px-3 py-2 text-center font-medium text-muted-foreground">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {samples.map(sample => {
              const isCalculating = calculatingIds.has(sample.id)
              const canCalculate = sample.status === 'pending'

              return (
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
                  <td className="px-3 py-2 text-center">
                    {canCalculate && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onCalculate(sample.id)}
                        disabled={isCalculating}
                      >
                        {isCalculating ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Calculator className="size-4" />
                        )}
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}
