import { useEffect } from 'react'
import { check } from '@tauri-apps/plugin-updater'
import { useUIStore } from './store/ui-store'
import { initializeCommandSystem } from './lib/commands'
import { buildAppMenu, setupMenuLanguageListener } from './lib/menu'
import { initializeLanguage } from './i18n/language-init'
import { logger } from './lib/logger'
import { cleanupOldFiles } from './lib/recovery'
import { commands } from './lib/tauri-bindings'
import './App.css'
import { MainWindow } from './components/layout/MainWindow'
import { ThemeProvider } from './components/ThemeProvider'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoginPage } from './components/auth/LoginPage'
import { useAuthStore } from './store/auth-store'
import { fetchCurrentUser } from './lib/auth-api'

function App() {
  const isAuthenticated = useAuthStore(state => state.isAuthenticated)
  const isLoading = useAuthStore(state => state.isLoading)
  const clearAuth = useAuthStore(state => state.clearAuth)

  // Validate persisted token on mount
  useEffect(() => {
    const validateToken = async () => {
      const token = useAuthStore.getState().token
      if (!token) {
        useAuthStore.getState().setLoading(false)
        return
      }
      try {
        await fetchCurrentUser()
      } catch {
        clearAuth()
      }
      useAuthStore.getState().setLoading(false)
    }
    validateToken()
  }, [clearAuth])

  // Initialize command system and cleanup on app startup
  useEffect(() => {
    logger.info('Frontend application starting up')
    initializeCommandSystem()
    logger.debug('Command system initialized')

    // Initialize language based on saved preference or system locale
    const initLanguageAndMenu = async () => {
      try {
        // Load preferences to get saved language
        const result = await commands.loadPreferences()
        const savedLanguage =
          result.status === 'ok' ? result.data.language : null

        // Initialize language (will use system locale if no preference)
        await initializeLanguage(savedLanguage)

        // Build the application menu with the initialized language
        await buildAppMenu()
        logger.debug('Application menu built')
        setupMenuLanguageListener()
      } catch (error) {
        logger.warn('Failed to initialize language or menu', { error })
      }
    }

    initLanguageAndMenu()

    // Clean up old recovery files on startup
    cleanupOldFiles().catch(error => {
      logger.warn('Failed to cleanup old recovery files', { error })
    })

    // Example of logging with context
    logger.info('App environment', {
      isDev: import.meta.env.DEV,
      mode: import.meta.env.MODE,
    })

    // Check for updates silently in the background — notify via sidebar banner when ready
    const checkForUpdates = async () => {
      try {
        const update = await check()
        if (update) {
          logger.info(`Update available: ${update.version}, downloading in background`)
          useUIStore.getState().setUpdateVersion(update.version)
          await update.downloadAndInstall(event => {
            if (event.event === 'Finished') {
              logger.info('Update downloaded, ready to install')
              useUIStore.getState().setUpdateReady(true)
            }
          })
        }
      } catch (error) {
        // Silent fail — don't interrupt lab techs over a network/update issue
        logger.warn(`Update check failed: ${String(error)}`)
      }
    }

    const updateTimer = setTimeout(checkForUpdates, 5000)
    return () => clearTimeout(updateTimer)
  }, [])

  // Show nothing while validating persisted token
  if (isLoading) {
    return null
  }

  return (
    <ErrorBoundary>
      <ThemeProvider>
        {isAuthenticated ? <MainWindow /> : <LoginPage />}
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
