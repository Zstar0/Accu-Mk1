import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { SettingsSection } from '../shared/SettingsComponents'
import { cn } from '@/lib/utils'
import { getSettings, updateSetting, type Setting } from '@/lib/api'
import {
  READ_SOURCE_SETTING_KEY,
  parseGlobalReadSource,
  type PageKey,
  type ReadSource,
} from '@/lib/read-source'
import { useAuthStore } from '@/store/auth-store'

const PAGES: { key: PageKey; label: string }[] = [
  { key: 'sample_details', label: 'Sample details' },
  { key: 'samples_list', label: 'Samples list' },
]

/**
 * Parse settings array into a map for easy access.
 */
function settingsToMap(settings: Setting[]): Map<string, string> {
  return new Map(settings.map(s => [s.key, s.value]))
}

/**
 * DataSourcePane - global per-page default for whether a page reads its
 * basic-info live from SENAITE or from the local Accu-Mk1 registry. Editing
 * is admin-only; any user can still override the default for themselves per
 * page (see ReadSourceIndicator + the per-page tri-state override control).
 */
export function DataSourcePane() {
  const queryClient = useQueryClient()
  const isAdmin = useAuthStore(s => s.user?.role === 'admin')

  // Local form state
  const [sourceByPage, setSourceByPage] = useState<Record<PageKey, ReadSource>>({
    sample_details: 'senaite',
    samples_list: 'senaite',
  })
  const [isDirty, setIsDirty] = useState(false)

  // Fetch settings from backend
  const {
    data: settings,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  })

  // Sync form state from fetched settings (render-time pattern per React docs)
  const [prevSettings, setPrevSettings] = useState<Setting[] | undefined>(
    undefined
  )
  if (settings && settings !== prevSettings) {
    setPrevSettings(settings)
    const settingsMap = settingsToMap(settings)
    const globalMap = parseGlobalReadSource(settingsMap.get(READ_SOURCE_SETTING_KEY))

    setSourceByPage({
      sample_details: globalMap.sample_details ?? 'senaite',
      samples_list: globalMap.samples_list ?? 'senaite',
    })
    setIsDirty(false)
  }

  // Mutation for saving the global map
  const saveMutation = useMutation({
    mutationFn: () =>
      updateSetting(READ_SOURCE_SETTING_KEY, JSON.stringify(sourceByPage)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      setIsDirty(false)
      toast.success('Data source defaults saved')
    },
    onError: () => {
      toast.error('Failed to save data source defaults')
    },
  })

  const handleChange = (page: PageKey, source: ReadSource) => {
    setSourceByPage(prev => ({ ...prev, [page]: source }))
    setIsDirty(true)
  }

  const handleSave = () => {
    saveMutation.mutate()
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  if (isError) {
    return <div className="text-destructive py-4">Failed to load settings</div>
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Applies to all users. Anyone can override per page.
      </p>

      {PAGES.map(({ key, label }) => (
        <SettingsSection key={key} title={label}>
          <div className="flex items-center gap-0.5 rounded border p-0.5 w-fit">
            {(['senaite', 'mk1'] as const).map(source => (
              <button
                key={source}
                type="button"
                disabled={!isAdmin}
                aria-label={`${label}: ${source === 'mk1' ? 'Accu-Mk1' : 'SENAITE'}`}
                onClick={() => handleChange(key, source)}
                className={cn(
                  'px-2 py-1 text-xs font-mono rounded disabled:opacity-50 disabled:cursor-not-allowed',
                  sourceByPage[key] === source
                    ? 'bg-emerald-600/30 text-emerald-400'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {source === 'mk1' ? 'Accu-Mk1' : 'SENAITE'}
              </button>
            ))}
          </div>

          {key === 'samples_list' && (
            <p className="text-xs text-muted-foreground">
              Samples-list Accu-Mk1 is preview-only until freshness sync
              ships — leave on SENAITE for everyone.
            </p>
          )}

          {!isAdmin && (
            <p className="text-xs text-muted-foreground">
              Only admins can change this.
            </p>
          )}
        </SettingsSection>
      ))}

      {isAdmin && (
        <div className="flex justify-end">
          <Button
            onClick={handleSave}
            disabled={!isDirty || saveMutation.isPending}
          >
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  )
}
