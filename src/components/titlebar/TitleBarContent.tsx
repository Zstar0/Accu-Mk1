import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'
import { executeCommand, useCommandContext } from '@/lib/commands'
import { useTheme } from '@/hooks/use-theme'
import { Switch } from '@/components/ui/switch'
import {
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
  Settings,
  Sun,
  Moon,
} from 'lucide-react'

/**
 * Left-side toolbar actions (sidebar toggle).
 * Place this after window controls on macOS, or at the start on Windows/Linux.
 */
export function TitleBarLeftActions() {
  const { t } = useTranslation()
  const leftSidebarVisible = useUIStore(state => state.leftSidebarVisible)
  const toggleLeftSidebar = useUIStore(state => state.toggleLeftSidebar)

  return (
    <div className="flex items-center gap-1">
      <Button
        onClick={toggleLeftSidebar}
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-foreground/70 hover:text-foreground"
        title={t(
          leftSidebarVisible
            ? 'titlebar.hideLeftSidebar'
            : 'titlebar.showLeftSidebar'
        )}
      >
        {leftSidebarVisible ? (
          <PanelLeftClose className="h-3 w-3" />
        ) : (
          <PanelLeft className="h-3 w-3" />
        )}
      </Button>
    </div>
  )
}

/**
 * Right-side toolbar actions (settings, sidebar toggle).
 * Place this before window controls on Windows, or at the end on macOS/Linux.
 */
export function TitleBarRightActions() {
  const { t } = useTranslation()
  const rightSidebarVisible = useUIStore(state => state.rightSidebarVisible)
  const toggleRightSidebar = useUIStore(state => state.toggleRightSidebar)
  const commandContext = useCommandContext()
  const { theme, setTheme } = useTheme()

  // Resolve effective theme — 'system' follows OS preference
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const handleOpenPreferences = async () => {
    const result = await executeCommand('open-preferences', commandContext)
    if (!result.success && result.error) {
      commandContext.showToast(result.error, 'error')
    }
  }

  const handleThemeToggle = (e: React.MouseEvent) => {
    const newTheme = isDark ? 'light' : 'dark'
    const root = document.documentElement
    root.style.setProperty('--theme-x', `${e.clientX}px`)
    root.style.setProperty('--theme-y', `${e.clientY}px`)

    if (!('startViewTransition' in document)) {
      setTheme(newTheme)
      return
    }

    ;(document as Document & {
      startViewTransition: (fn: () => void) => void
    }).startViewTransition(() => flushSync(() => setTheme(newTheme)))
  }

  return (
    <div className="flex items-center gap-1">
      <div
        className="flex items-center gap-1 text-foreground/70 cursor-pointer"
        title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        onClick={handleThemeToggle}
      >
        <Sun className="h-3 w-3" />
        <Switch
          checked={isDark}
          onCheckedChange={() => {}}
          className="h-4 w-7 data-[state=checked]:bg-primary/60 pointer-events-none"
        />
        <Moon className="h-3 w-3" />
      </div>

      <Button
        onClick={handleOpenPreferences}
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-foreground/70 hover:text-foreground"
        title={t('titlebar.settings')}
      >
        <Settings className="h-3 w-3" />
      </Button>

      <Button
        onClick={toggleRightSidebar}
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-foreground/70 hover:text-foreground"
        title={t(
          rightSidebarVisible
            ? 'titlebar.hideRightSidebar'
            : 'titlebar.showRightSidebar'
        )}
      >
        {rightSidebarVisible ? (
          <PanelRightClose className="h-3 w-3" />
        ) : (
          <PanelRight className="h-3 w-3" />
        )}
      </Button>
    </div>
  )
}

interface TitleBarTitleProps {
  title?: string
}

/**
 * Centered title for the title bar.
 * Uses absolute positioning to stay centered regardless of other content.
 */
export function TitleBarTitle({ title = 'Tauri App' }: TitleBarTitleProps) {
  return (
    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
      <span className="text-sm font-medium text-foreground/80">{title}</span>
    </div>
  )
}

/**
 * Combined toolbar content for simple layouts.
 * Use this for Linux or when you want all toolbar items in one fragment.
 *
 * For more control, use TitleBarLeftActions, TitleBarRightActions, and TitleBarTitle separately.
 */
export function TitleBarContent({ title = 'Tauri App' }: TitleBarTitleProps) {
  return (
    <>
      <TitleBarLeftActions />
      <TitleBarTitle title={title} />
      <TitleBarRightActions />
    </>
  )
}
