import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { SettingsField, SettingsSection } from '../shared/SettingsComponents'
import {
  getSettings,
  updateSetting,
  type Setting,
  type ColumnMappings,
} from '@/lib/api'

/**
 * Parse settings array into a map for easy access.
 */
function settingsToMap(settings: Setting[]): Map<string, string> {
  return new Map(settings.map(s => [s.key, s.value]))
}

/**
 * DataPipelinePane - Settings for report directory and column mappings.
 * These settings are persisted to the backend SQLite database.
 */
export function DataPipelinePane() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  // Local form state
  const [reportDirectory, setReportDirectory] = useState('')
  const [columnMappings, setColumnMappings] = useState<ColumnMappings>({
    peak_area: 'Area',
    retention_time: 'RT',
    compound_name: 'Name',
  })
  const [isDirty, setIsDirty] = useState(false)

  // Fetch settings from backend
  const { data: settings, isLoading, isError } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  })

  // Initialize form state from fetched settings
  useEffect(() => {
    if (settings) {
      const settingsMap = settingsToMap(settings)

      const reportDir = settingsMap.get('report_directory') ?? ''
      setReportDirectory(reportDir)

      const mappingsJson = settingsMap.get('column_mappings')
      if (mappingsJson) {
        try {
          const parsed = JSON.parse(mappingsJson) as ColumnMappings
          setColumnMappings(parsed)
        } catch {
          console.error('Failed to parse column_mappings JSON')
        }
      }

      setIsDirty(false)
    }
  }, [settings])

  // Mutation for saving settings
  const saveMutation = useMutation({
    mutationFn: async () => {
      // Save both settings in parallel
      await Promise.all([
        updateSetting('report_directory', reportDirectory),
        updateSetting('column_mappings', JSON.stringify(columnMappings)),
      ])
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      setIsDirty(false)
      toast.success(t('preferences.dataPipeline.saveSuccess'))
    },
    onError: () => {
      toast.error(t('preferences.dataPipeline.saveError'))
    },
  })

  // Handle form changes
  const handleReportDirectoryChange = (value: string) => {
    setReportDirectory(value)
    setIsDirty(true)
  }

  const handleColumnMappingChange = (key: keyof ColumnMappings, value: string) => {
    setColumnMappings(prev => ({ ...prev, [key]: value }))
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
    return (
      <div className="text-destructive py-4">
        {t('preferences.dataPipeline.loadError')}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <SettingsSection title={t('preferences.dataPipeline.fileSettings')}>
        <SettingsField
          label={t('preferences.dataPipeline.reportDirectory')}
          description={t('preferences.dataPipeline.reportDirectoryDescription')}
        >
          <Input
            value={reportDirectory}
            onChange={e => handleReportDirectoryChange(e.target.value)}
            placeholder={t('preferences.dataPipeline.reportDirectoryPlaceholder')}
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title={t('preferences.dataPipeline.columnMappingsTitle')}>
        <p className="text-sm text-muted-foreground mb-4">
          {t('preferences.dataPipeline.columnMappingsDescription')}
        </p>

        <SettingsField
          label={t('preferences.dataPipeline.peakArea')}
          description={t('preferences.dataPipeline.peakAreaDescription')}
        >
          <Input
            value={columnMappings.peak_area}
            onChange={e => handleColumnMappingChange('peak_area', e.target.value)}
          />
        </SettingsField>

        <SettingsField
          label={t('preferences.dataPipeline.retentionTime')}
          description={t('preferences.dataPipeline.retentionTimeDescription')}
        >
          <Input
            value={columnMappings.retention_time}
            onChange={e => handleColumnMappingChange('retention_time', e.target.value)}
          />
        </SettingsField>

        <SettingsField
          label={t('preferences.dataPipeline.compoundName')}
          description={t('preferences.dataPipeline.compoundNameDescription')}
        >
          <Input
            value={columnMappings.compound_name}
            onChange={e => handleColumnMappingChange('compound_name', e.target.value)}
          />
        </SettingsField>
      </SettingsSection>

      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          disabled={!isDirty || saveMutation.isPending}
        >
          {saveMutation.isPending
            ? t('preferences.dataPipeline.saving')
            : t('preferences.dataPipeline.saveSettings')}
        </Button>
      </div>
    </div>
  )
}
