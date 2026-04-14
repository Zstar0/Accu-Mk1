import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { getApiBaseUrl } from '@/lib/config'
import { getAuthToken } from '@/store/auth-store'

interface SyncStatus {
  source_published: number
  source_verification_codes: number
  report_table_rows: number
  report_verification_codes: number
  missing_codes: string[]
  orphaned_codes: string[]
  in_sync: boolean
}

function getBearerHeaders(): HeadersInit {
  const token = getAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function fetchSyncStatus(): Promise<SyncStatus> {
  const response = await fetch(`${getApiBaseUrl()}/reports/sync-status`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Sync status failed: ${response.status}`)
  return response.json()
}

async function triggerResync(): Promise<{ synced: number; removed: number; message: string }> {
  const response = await fetch(`${getApiBaseUrl()}/reports/resync`, {
    method: 'POST',
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Resync failed: ${response.status}`)
  return response.json()
}

function StatRow({ label, value, mismatch }: { label: string; value: number | string; mismatch?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/20">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-sm font-mono font-medium', mismatch && 'text-amber-400')}>
        {value}
      </span>
    </div>
  )
}

export function ReportsSyncDebug() {
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['reports', 'sync-status'],
    queryFn: fetchSyncStatus,
    staleTime: 0,
  })

  const handleResync = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const result = await triggerResync()
      setSyncResult(result.message)
      queryClient.invalidateQueries({ queryKey: ['reports'] })
      refetch()
    } catch (e) {
      setSyncResult(`Error: ${e instanceof Error ? e.message : 'Unknown'}`)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Reports Sync Debug</h1>
          <p className="text-xs text-muted-foreground">
            Compare published_coa_results with coa_generations source
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', isLoading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-sm">
          <XCircle className="h-4 w-4" />
          Failed to load sync status
        </div>
      )}

      {data && (
        <>
          {/* Sync status badge */}
          <div className={cn(
            'flex items-center gap-2 rounded-lg border px-4 py-3',
            data.in_sync
              ? 'border-emerald-500/30 bg-emerald-500/5'
              : 'border-amber-500/30 bg-amber-500/5'
          )}>
            {data.in_sync ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-400" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-400" />
            )}
            <span className={cn('text-sm font-medium', data.in_sync ? 'text-emerald-400' : 'text-amber-400')}>
              {data.in_sync ? 'Tables are in sync' : 'Tables are out of sync'}
            </span>
          </div>

          {/* Comparison */}
          <div className="rounded-lg border border-border/50 bg-card/30 p-3">
            <StatRow label="Source COAs (coa_generations)" value={data.source_verification_codes} />
            <StatRow
              label="Report COAs (published_coa_results)"
              value={data.report_verification_codes}
              mismatch={data.report_verification_codes !== data.source_verification_codes}
            />
            <StatRow label="Report detail rows (analytes)" value={data.report_table_rows} />
          </div>

          {/* Missing codes */}
          {data.missing_codes.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="text-xs font-medium text-amber-400 mb-1">
                Missing from report table ({data.missing_codes.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {data.missing_codes.map(code => (
                  <span key={code} className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300">
                    {code}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Orphaned codes */}
          {data.orphaned_codes.length > 0 && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
              <div className="text-xs font-medium text-red-400 mb-1">
                Orphaned in report table ({data.orphaned_codes.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {data.orphaned_codes.map(code => (
                  <span key={code} className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-300">
                    {code}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Resync button */}
          {!data.in_sync && (
            <div className="flex items-center gap-3">
              <Button onClick={handleResync} disabled={syncing} variant="outline" size="sm">
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                )}
                Re-sync Now
              </Button>
              {syncResult && (
                <span className="text-xs text-muted-foreground">{syncResult}</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
