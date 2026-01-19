import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ShortcutPicker } from '../ShortcutPicker'
import { SettingsField, SettingsSection } from '../shared/SettingsComponents'
import { usePreferences, useSavePreferences } from '@/services/preferences'
import { commands } from '@/lib/tauri-bindings'
import { logger } from '@/lib/logger'
import { getApiKey, setApiKey, isValidApiKeyFormat } from '@/lib/api-key'

export function GeneralPane() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  
  // API Key state
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isApiKeyConfigured, setIsApiKeyConfigured] = useState(false)
  
  // Load saved API key on mount
  useEffect(() => {
    const savedKey = getApiKey()
    if (savedKey) {
      setApiKeyInput(savedKey)
      setIsApiKeyConfigured(true)
    }
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
    staleTime: Infinity, // Never refetch - this is a constant
  })

  const handleShortcutChange = async (newShortcut: string | null) => {
    if (!preferences) return

    // Capture old shortcut for rollback if save fails
    const oldShortcut = preferences.quick_pane_shortcut

    logger.info('Updating quick pane shortcut', { oldShortcut, newShortcut })

    // First, try to register the new shortcut
    const result = await commands.updateQuickPaneShortcut(newShortcut)

    if (result.status === 'error') {
      logger.error('Failed to register shortcut', { error: result.error })
      toast.error(t('toast.error.shortcutFailed'), {
        description: result.error,
      })
      return
    }

    // If registration succeeded, try to save the preference
    try {
      await savePreferences.mutateAsync({
        ...preferences,
        quick_pane_shortcut: newShortcut,
      })
    } catch {
      // Save failed - roll back the backend registration
      logger.warn('Save failed, rolling back shortcut registration', {
        oldShortcut,
        newShortcut,
      })

      const rollbackResult = await commands.updateQuickPaneShortcut(oldShortcut)

      if (rollbackResult.status === 'error') {
        logger.error(
          'Rollback failed - backend and preferences are out of sync',
          {
            error: rollbackResult.error,
            attemptedShortcut: newShortcut,
            originalShortcut: oldShortcut,
          }
        )
        toast.error(t('toast.error.shortcutRestoreFailed'), {
          description: t('toast.error.shortcutRestoreDescription'),
        })
      } else {
        logger.info('Successfully rolled back shortcut registration')
      }
    }
  }

  const handleSaveApiKey = () => {
    if (!apiKeyInput.trim()) {
      toast.error('API key cannot be empty')
      return
    }
    
    if (!isValidApiKeyFormat(apiKeyInput)) {
      toast.error('Invalid API key format', {
        description: 'API key should start with "ak_"',
      })
      return
    }
    
    setApiKey(apiKeyInput)
    setIsApiKeyConfigured(true)
    // Invalidate explorer queries to trigger re-fetch with new key
    queryClient.invalidateQueries({ queryKey: ['explorer'] })
    toast.success('API key saved', {
      description: 'You may need to refresh the app for changes to take effect.',
    })
    logger.info('API key updated')
  }

  const handleClearApiKey = () => {
    setApiKey('')
    setApiKeyInput('')
    setIsApiKeyConfigured(false)
    queryClient.invalidateQueries({ queryKey: ['explorer'] })
    toast.info('API key cleared')
    logger.info('API key cleared')
  }

  return (
    <div className="space-y-6">
      {/* API Key Section - First for visibility */}
      <SettingsSection title="API Key">
        <SettingsField
          label="Backend API Key"
          description="Enter your API key to connect to the backend. Get this from your administrator."
        >
          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKeyInput}
                  onChange={e => setApiKeyInput(e.target.value)}
                  placeholder="ak_xxxxx..."
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3"
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <Button onClick={handleSaveApiKey}>
                Save
              </Button>
              {isApiKeyConfigured && (
                <Button variant="outline" onClick={handleClearApiKey}>
                  Clear
                </Button>
              )}
            </div>
            
            {/* Status indicator */}
            <div className="flex items-center gap-2 text-sm">
              {isApiKeyConfigured ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <span className="text-green-600">API key configured</span>
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4 text-yellow-500" />
                  <span className="text-yellow-600">No API key configured - AccuMark Tools features require an API key</span>
                </>
              )}
            </div>
          </div>
        </SettingsField>
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

