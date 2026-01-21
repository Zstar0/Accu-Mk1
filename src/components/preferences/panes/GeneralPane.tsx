import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, Eye, EyeOff, Plus, Trash2, Plug } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ShortcutPicker } from '../ShortcutPicker'
import { SettingsField, SettingsSection } from '../shared/SettingsComponents'
import { usePreferences, useSavePreferences } from '@/services/preferences'
import { commands } from '@/lib/tauri-bindings'
import { logger } from '@/lib/logger'
import { useUIStore } from '@/store/ui-store'
import {
  getProfiles,
  getActiveProfileId,
  setActiveProfileId,
  updateProfile,
  addProfile,
  deleteProfile,
  API_PROFILE_CHANGED_EVENT,
  type ApiProfile,
} from '@/lib/api-profiles'

export function GeneralPane() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const setPreferencesOpen = useUIStore(state => state.setPreferencesOpen)
  
  // Profile state
  const [profiles, setProfiles] = useState<ApiProfile[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  
  // Load profiles on mount
  useEffect(() => {
    refreshProfiles()
  }, [])
  
  const refreshProfiles = () => {
    const loadedProfiles = getProfiles()
    const loadedActiveId = getActiveProfileId()
    setProfiles(loadedProfiles)
    setActiveId(loadedActiveId)
    
    // Load active profile data
    const activeProfile = loadedProfiles.find(p => p.id === loadedActiveId)
    if (activeProfile) {
      setServerUrl(activeProfile.serverUrl)
      setApiKeyInput(activeProfile.apiKey)
    }
    setHasChanges(false)
  }
  
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
      toast.error(t('toast.error.shortcutFailed'), { description: result.error })
      return
    }
    try {
      await savePreferences.mutateAsync({ ...preferences, quick_pane_shortcut: newShortcut })
    } catch {
      logger.warn('Save failed, rolling back shortcut registration', { oldShortcut, newShortcut })
      const rollbackResult = await commands.updateQuickPaneShortcut(oldShortcut)
      if (rollbackResult.status === 'error') {
        logger.error('Rollback failed', { error: rollbackResult.error })
        toast.error(t('toast.error.shortcutRestoreFailed'))
      }
    }
  }

  const handleProfileChange = (profileId: string) => {
    setActiveProfileId(profileId)
    setActiveId(profileId)
    const profile = profiles.find(p => p.id === profileId)
    if (profile) {
      setServerUrl(profile.serverUrl)
      setApiKeyInput(profile.apiKey)
    }
    setHasChanges(false)
    queryClient.invalidateQueries({ queryKey: ['explorer'] })
    toast.success('Switched profile', { description: `Now using ${profile?.name}` })
  }

  const handleSaveProfile = () => {
    if (!activeId) return
    updateProfile(activeId, { serverUrl, apiKey: apiKeyInput })
    refreshProfiles()
    queryClient.invalidateQueries({ queryKey: ['explorer'] })
    toast.success('Profile saved')
    logger.info('Profile updated', { profileId: activeId })
  }

  const handleAddProfile = () => {
    const newProfile = addProfile({
      name: `Profile ${profiles.length + 1}`,
      serverUrl: 'http://127.0.0.1:8009',
      apiKey: '',
    })
    refreshProfiles()
    handleProfileChange(newProfile.id)
    toast.success('New profile created')
  }

  const handleDeleteProfile = () => {
    if (!activeId || profiles.length <= 1) {
      toast.error('Cannot delete the last profile')
      return
    }
    const profileName = profiles.find(p => p.id === activeId)?.name
    deleteProfile(activeId)
    refreshProfiles()
    queryClient.invalidateQueries({ queryKey: ['explorer'] })
    toast.info(`Deleted profile: ${profileName}`)
  }

  const handleFieldChange = (field: 'serverUrl' | 'apiKey', value: string) => {
    if (field === 'serverUrl') setServerUrl(value)
    else setApiKeyInput(value)
    setHasChanges(true)
  }

  const handleConnect = async () => {
    if (!activeId) return
    if (!apiKeyInput.trim()) {
      toast.error('API key is required to connect')
      return
    }
    
    setIsConnecting(true)
    
    // Save profile first
    updateProfile(activeId, { serverUrl, apiKey: apiKeyInput })
    refreshProfiles()
    
    // Clear all cached queries
    queryClient.clear()
    
    // Dispatch profile changed event to notify the app
    window.dispatchEvent(new CustomEvent(API_PROFILE_CHANGED_EVENT, { 
      detail: { activeProfileId: activeId } 
    }))
    
    // Close preferences dialog
    setPreferencesOpen(false)
    
    // Show success message
    toast.success(`Connected to ${profiles.find(p => p.id === activeId)?.name}`, {
      description: 'App has been reset with new connection.',
    })
    
    logger.info('Connected to API profile', { profileId: activeId, serverUrl })
    setIsConnecting(false)
    setHasChanges(false)
  }

  const activeProfile = profiles.find(p => p.id === activeId)
  const isApiKeyConfigured = apiKeyInput.length > 0

  return (
    <div className="space-y-6">
      {/* API Connection Section */}
      <SettingsSection title="API Connection">
        {/* Profile Selector */}
        <SettingsField
          label="Profile"
          description="Select a saved profile or create a new one"
        >
          <div className="flex gap-2">
            <Select value={activeId ?? ''} onValueChange={handleProfileChange}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="Select profile" />
              </SelectTrigger>
              <SelectContent>
                {profiles.map(profile => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" onClick={handleAddProfile}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </SettingsField>

        {/* Server URL */}
        <SettingsField
          label="Server URL"
          description="The Integration Service API endpoint"
        >
          <Input
            value={serverUrl}
            onChange={e => handleFieldChange('serverUrl', e.target.value)}
            placeholder="https://api.accumarklabs.com"
          />
        </SettingsField>

        {/* API Key */}
        <SettingsField
          label="API Key"
          description="Authentication key for the Integration Service"
        >
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showApiKey ? 'text' : 'password'}
                value={apiKeyInput}
                onChange={e => handleFieldChange('apiKey', e.target.value)}
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
          </div>
        </SettingsField>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <Button onClick={handleSaveProfile} disabled={!hasChanges} variant="outline">
            Save Profile
          </Button>
          <Button onClick={handleConnect} disabled={isConnecting || !apiKeyInput.trim()}>
            <Plug className="h-4 w-4 mr-2" />
            {isConnecting ? 'Connecting...' : 'Connect'}
          </Button>
          <Button variant="destructive" size="icon" onClick={handleDeleteProfile} disabled={profiles.length <= 1}>
            <Trash2 className="h-4 w-4" />
          </Button>
          
          {/* Status indicator */}
          <div className="flex items-center gap-2 text-sm ml-auto">
            {isApiKeyConfigured ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span className="text-green-600">{activeProfile?.name}</span>
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4 text-yellow-500" />
                <span className="text-yellow-600">API key required</span>
              </>
            )}
          </div>
        </div>
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

