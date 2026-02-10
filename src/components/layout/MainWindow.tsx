import { useState, useEffect } from 'react'
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { TitleBar } from '@/components/titlebar/TitleBar'
import { AppSidebar } from './AppSidebar'
import { MainWindowContent } from './MainWindowContent'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { PreferencesDialog } from '@/components/preferences/PreferencesDialog'
import { Toaster } from 'sonner'
import { useTheme } from '@/hooks/use-theme'
import { useMainWindowEventListeners } from '@/hooks/useMainWindowEventListeners'
import {
  getActiveEnvironmentName,
  hasOverride,
  API_PROFILE_CHANGED_EVENT,
} from '@/lib/api-profiles'
import { healthCheck, type HealthResponse } from '@/lib/api'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'

// Backend connection status type
type BackendStatus =
  | { state: 'loading' }
  | { state: 'connected'; data: HealthResponse }
  | { state: 'error'; message: string }

export function MainWindow() {
  const { theme } = useTheme()
  const [envName, setEnvName] = useState<string | null>(null)
  const [isOverridden, setIsOverridden] = useState(false)
  const [backendStatus, setBackendStatus] = useState<BackendStatus>({
    state: 'loading',
  })

  // Set up global event listeners (keyboard shortcuts, etc.)
  useMainWindowEventListeners()

  // Track active environment and backend status
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null

    const updateEnvInfo = () => {
      setEnvName(getActiveEnvironmentName())
      setIsOverridden(hasOverride())
    }

    const checkBackend = async () => {
      try {
        const health = await healthCheck()
        setBackendStatus({ state: 'connected', data: health })
        // Clear interval when connected
        if (intervalId) {
          clearInterval(intervalId)
          intervalId = null
        }
      } catch {
        setBackendStatus({
          state: 'error',
          message: 'Backend Offline',
        })
        // Set up polling if not already polling
        if (!intervalId) {
          intervalId = setInterval(checkBackend, 5000)
        }
      }
    }

    // Listen for environment changes (admin override)
    const handleProfileChange = () => {
      updateEnvInfo()
      checkBackend()
    }

    // Initial checks
    updateEnvInfo()
    checkBackend()

    window.addEventListener(API_PROFILE_CHANGED_EVENT, handleProfileChange)

    return () => {
      window.removeEventListener(API_PROFILE_CHANGED_EVENT, handleProfileChange)
      if (intervalId) clearInterval(intervalId)
    }
  }, [])

  const renderStatusText = () => {
    switch (backendStatus.state) {
      case 'loading':
        return <span className="text-muted-foreground">Connecting...</span>
      case 'connected':
        return (
          <span className="text-green-600 dark:text-green-500">
            Connected - {envName || 'Unknown'}
            {isOverridden && (
              <Badge
                variant="outline"
                className="ml-1.5 text-[10px] px-1.5 py-0 border-amber-500 text-amber-600 dark:text-amber-400"
              >
                override
              </Badge>
            )}
          </span>
        )
      case 'error':
        return (
          <span className="text-red-500 font-medium">
            {backendStatus.message}
          </span>
        )
    }
  }

  return (
    <SidebarProvider>
      <div className="relative flex h-screen w-full flex-col overflow-hidden rounded-xl bg-background">
        <TitleBar />

        <div className="flex flex-1 overflow-hidden">
          <AppSidebar />

          <SidebarInset>
            {/* Header with sidebar trigger */}
            <header className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-2 h-4" />
              <span className="text-sm text-muted-foreground">Accu-Mk1</span>
            </header>

            {/* Main content area */}
            <div className="flex-1 overflow-auto p-4">
              <MainWindowContent />
            </div>
          </SidebarInset>
        </div>

        {/* Global UI Components (hidden until triggered) */}
        <CommandPalette />
        <PreferencesDialog />
        <Toaster
          position="bottom-right"
          theme={
            theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system'
          }
          className="toaster group"
          toastOptions={{
            classNames: {
              toast:
                'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
              description: 'group-[.toast]:text-muted-foreground',
              actionButton:
                'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
              cancelButton:
                'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
            },
          }}
        />

        {/* Version footer */}
        <div className="absolute bottom-1 left-1/2 -translate-x-1/2 text-xs text-muted-foreground/50 flex items-center gap-2 select-none pointer-events-none">
          <span>Accu-Mk1 Ver. 0.4.1</span>
          <span>•</span>
          {renderStatusText()}
        </div>
      </div>
    </SidebarProvider>
  )
}
