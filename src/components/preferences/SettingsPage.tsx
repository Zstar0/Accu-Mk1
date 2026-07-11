import { useTranslation } from 'react-i18next'
import { useUIStore } from '@/store/ui-store'
import { cn } from '@/lib/utils'
import { navigationItems, PANE_COMPONENTS, isPreferencePane } from './panes'

/**
 * Full-page Settings (#settings/<pane>), replacing the retired
 * PreferencesDialog overlay. A left nav column drives the pane switch through
 * ui-store navigation (so the hash, back/forward, and gear highlight all work);
 * the wide content area gives room for the Flags pane's type-bucket board.
 */
export function SettingsPage() {
  const { t } = useTranslation()
  const activeSubSection = useUIStore(state => state.activeSubSection)
  const navigateTo = useUIStore(state => state.navigateTo)

  // The pane is the current subsection; anything else (e.g. a stale 'overview')
  // falls back to the general pane so the page never renders blank.
  const pane = isPreferencePane(activeSubSection) ? activeSubSection : 'general'
  const PaneComponent = PANE_COMPONENTS[pane]

  return (
    <div className="flex h-full min-h-0 w-full font-sans">
      <nav className="w-56 shrink-0 border-r p-3">
        <p className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('preferences.title')}
        </p>
        <ul className="space-y-0.5">
          {navigationItems.map(item => {
            const isActive = pane === item.id
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => navigateTo('settings', item.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span>{t(item.labelKey)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        <h2 className="mb-4 text-lg font-semibold">
          {t(`preferences.${pane}`)}
        </h2>
        <PaneComponent />
      </main>
    </div>
  )
}

export default SettingsPage
