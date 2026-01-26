import { useState, useEffect } from 'react'
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar'
import { TitleBar } from '@/components/titlebar/TitleBar'
import { AppSidebar } from './AppSidebar'
import { MainWindowContent } from './MainWindowContent'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { PreferencesDialog } from '@/components/preferences/PreferencesDialog'
import { Toaster } from 'sonner'
import { useTheme } from '@/hooks/use-theme'
import { useMainWindowEventListeners } from '@/hooks/useMainWindowEventListeners'
import { getActiveProfile, API_PROFILE_CHANGED_EVENT } from '@/lib/api-profiles'
import { Separator } from '@/components/ui/separator'

export function MainWindow() {
  const { theme } = useTheme()
  const [profileName, setProfileName] = useState<string | null>(null)

  // Set up global event listeners (keyboard shortcuts, etc.)
  useMainWindowEventListeners()

  // Track active profile name
  useEffect(() => {
    const updateProfileName = () => {
      const profile = getActiveProfile()
      setProfileName(profile?.name ?? null)
    }
    updateProfileName()
    window.addEventListener(API_PROFILE_CHANGED_EVENT, updateProfileName)
    return () => window.removeEventListener(API_PROFILE_CHANGED_EVENT, updateProfileName)
  }, [])

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
              <span className="text-sm text-muted-foreground">
                {profileName && `Connected to ${profileName}`}
              </span>
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
        <div className="absolute bottom-1 left-1/2 -translate-x-1/2 text-xs text-muted-foreground/50 flex items-center gap-2">
          <span>Accu-Mk1 Ver. 0.3.1</span>
          {profileName && (
            <>
              <span>•</span>
              <span>{profileName}</span>
            </>
          )}
        </div>
      </div>
    </SidebarProvider>
  )
}
