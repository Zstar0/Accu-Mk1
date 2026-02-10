import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, AlertTriangle, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { ShortcutPicker } from '../ShortcutPicker'
import { SettingsField, SettingsSection } from '../shared/SettingsComponents'
import { usePreferences, useSavePreferences } from '@/services/preferences'
import { commands } from '@/lib/tauri-bindings'
import { logger } from '@/lib/logger'
import { useAuthStore } from '@/store/auth-store'
import {
  getServerUrl,
  getDefaultUrl,
  hasOverride,
  setOverride,
  clearOverride,
  getActiveEnvironmentName,
  KNOWN_ENVIRONMENTS,
} from '@/lib/api-profiles'

export function GeneralPane() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const user = useAuthStore(state => state.user)
  const isAdmin = user?.role === 'admin'

  // Track current API state
  const [currentUrl, setCurrentUrl] = useState(() => getServerUrl())
  const [currentEnvName, setCurrentEnvName] = useState(() =>
    getActiveEnvironmentName()
  )
  const [isOverridden, setIsOverridden] = useState(() => hasOverride())

  // Selected value for the dropdown (the environment id or 'custom')
  const [selectedEnvId, setSelectedEnvId] = useState<string>(() => {
    const url = getServerUrl()
    const known = KNOWN_ENVIRONMENTS.find(e => e.url === url)
    return known?.id ?? 'default'
  })

  // Sync state on mount
  useEffect(() => {
    setCurrentUrl(getServerUrl())
    setCurrentEnvName(getActiveEnvironmentName())
    setIsOverridden(hasOverride())
  }, [])

  // Load preferences for keyboard shortcuts
  const { data: preferences } = usePreferences()
  const savePreferences = useSavePreferences()

  // Get the default shortcut from the backend
  const { data: defaultShortcut } = useQuery({
    queryKey: ['default-quick-pane-shortcut'],
    queryFn: async () => {
      return await commands.getDefaultQuickPaneShortcut()
    },
    staleTime: Infinity,
  })

  const handleShortcutChange = async (newShortcut: string | null) => {
    if (!preferences) return
    const oldShortcut = preferences.quick_pane_shortcut
    logger.info('Updating quick pane shortcut', { oldShortcut, newShortcut })
    const result = await commands.updateQuickPaneShortcut(newShortcut)
    if (result.status === 'error') {
      logger.error('Failed to register shortcut', { error: result.error })
      toast.error(t('toast.error.shortcutFailed'), {
        description: result.error,
      })
      return
    }
    try {
      await savePreferences.mutateAsync({
        ...preferences,
        quick_pane_shortcut: newShortcut,
      })
    } catch {
      logger.warn('Save failed, rolling back shortcut registration', {
        oldShortcut,
        newShortcut,
      })
      const rollbackResult = await commands.updateQuickPaneShortcut(oldShortcut)
      if (rollbackResult.status === 'error') {
        logger.error('Rollback failed', { error: rollbackResult.error })
        toast.error(t('toast.error.shortcutRestoreFailed'))
      }
    }
  }

  const handleEnvironmentChange = (envId: string) => {
    setSelectedEnvId(envId)

    if (envId === 'default') {
      // Revert to build-time default
      clearOverride()
      queryClient.clear()
      setCurrentUrl(getServerUrl())
      setCurrentEnvName(getActiveEnvironmentName())
      setIsOverridden(false)
      toast.success('Reverted to default', {
        description: `Using build-time default: ${getDefaultUrl()}`,
      })
      logger.info('Cleared API override, using build default')
      return
    }

    const env = KNOWN_ENVIRONMENTS.find(e => e.id === envId)
    if (!env) return

    // If this is the same as the default, just clear the override
    if (env.url === getDefaultUrl()) {
      clearOverride()
    } else {
      setOverride(env.url)
    }

    queryClient.clear()
    setCurrentUrl(getServerUrl())
    setCurrentEnvName(getActiveEnvironmentName())
    setIsOverridden(hasOverride())

    toast.success(`Switched to ${env.name}`, {
      description: `API: ${env.url}`,
    })
    logger.info('Admin API override applied', {
      environment: env.name,
      url: env.url,
    })
  }

  const handleClearOverride = () => {
    clearOverride()
    queryClient.clear()
    setCurrentUrl(getServerUrl())
    setCurrentEnvName(getActiveEnvironmentName())
    setIsOverridden(false)
    setSelectedEnvId(() => {
      const url = getServerUrl()
      const known = KNOWN_ENVIRONMENTS.find(e => e.url === url)
      return known?.id ?? 'default'
    })
    toast.info('Override cleared', {
      description: `Reverted to build default: ${getDefaultUrl()}`,
    })
    logger.info('Admin cleared API override')
  }

  return (
    <div className="space-y-6">
      {/* API Connection Info */}
      <SettingsSection title="API Connection">
        <SettingsField
          label="Current Backend"
          description="The API server this app is connected to"
        >
          <div className="flex items-center gap-3">
            <code className="flex-1 rounded-md bg-muted px-3 py-2 text-sm font-mono">
              {currentUrl}
            </code>
            <Badge
              variant={isOverridden ? 'secondary' : 'default'}
              className={isOverridden ? '' : 'bg-green-600'}
            >
              {currentEnvName}
            </Badge>
          </div>
          {isOverridden && (
            <div className="mt-2 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>
                Session override active — will revert to{' '}
                <code className="rounded bg-muted px-1">{getDefaultUrl()}</code>{' '}
                when this tab is closed.
              </span>
            </div>
          )}
        </SettingsField>

        {/* Admin-only environment override */}
        {isAdmin && (
          <SettingsField
            label={
              <span className="flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5 text-primary" />
                Environment Override
              </span>
            }
            description="Admin only — temporarily point this session at a different backend"
          >
            <div className="flex items-center gap-2">
              <Select
                value={selectedEnvId}
                onValueChange={handleEnvironmentChange}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select environment" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">
                    Build Default ({getDefaultUrl()})
                  </SelectItem>
                  {KNOWN_ENVIRONMENTS.map(env => (
                    <SelectItem key={env.id} value={env.id}>
                      {env.name} — {env.url}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isOverridden && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearOverride}
                >
                  Clear Override
                </Button>
              )}
            </div>
          </SettingsField>
        )}

        {/* Non-admin info */}
        {!isAdmin && (
          <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
            <span>
              Connected to <strong>{currentEnvName}</strong>. Contact an admin
              to change the environment.
            </span>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t('preferences.general.keyboardShortcuts')}>
        <SettingsField
          label={t('preferences.general.quickPaneShortcut')}
          description={t('preferences.general.quickPaneShortcutDescription')}
        >
          <ShortcutPicker
            value={preferences?.quick_pane_shortcut ?? null}
            // Fallback matches DEFAULT_QUICK_PANE_SHORTCUT in src-tauri/src/lib.rs
            defaultValue={defaultShortcut ?? 'CommandOrControl+Shift+.'}
            onChange={handleShortcutChange}
            disabled={!preferences || savePreferences.isPending}
          />
        </SettingsField>
      </SettingsSection>
    </div>
  )
}
