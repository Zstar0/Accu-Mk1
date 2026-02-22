import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

// Navigation sections for main content area
export type ActiveSection = 'dashboard' | 'intake' | 'lab-operations' | 'hplc-analysis' | 'accumark-tools' | 'account'

// Sub-sections within each main section
export type DashboardSubSection = 'orders' | 'analytics' | 'senaite'
export type IntakeSubSection = 'receive-sample'
export type LabOperationsSubSection = 'chromatographs' | 'sample-intake'
export type HPLCAnalysisSubSection = 'overview' | 'new-analysis' | 'import-analysis' | 'peptide-config' | 'analysis-history'
export type AccuMarkToolsSubSection = 'overview' | 'order-explorer' | 'coa-explorer'
export type AccountSubSection = 'change-password' | 'user-management'
export type ActiveSubSection = DashboardSubSection | IntakeSubSection | LabOperationsSubSection | HPLCAnalysisSubSection | AccuMarkToolsSubSection | AccountSubSection

interface UIState {
  leftSidebarVisible: boolean
  rightSidebarVisible: boolean
  commandPaletteOpen: boolean
  preferencesOpen: boolean
  lastQuickPaneEntry: string | null
  activeSection: ActiveSection
  activeSubSection: ActiveSubSection
  navigationKey: number
  peptideConfigTargetId: number | null
  orderExplorerTargetOrderId: string | null
  updateVersion: string | null
  updateReady: boolean

  toggleLeftSidebar: () => void
  setLeftSidebarVisible: (visible: boolean) => void
  toggleRightSidebar: () => void
  setRightSidebarVisible: (visible: boolean) => void
  toggleCommandPalette: () => void
  setCommandPaletteOpen: (open: boolean) => void
  togglePreferences: () => void
  setPreferencesOpen: (open: boolean) => void
  setLastQuickPaneEntry: (text: string) => void
  setActiveSection: (section: ActiveSection) => void
  setActiveSubSection: (subSection: ActiveSubSection) => void
  navigateTo: (section: ActiveSection, subSection: ActiveSubSection) => void
  navigateToPeptide: (peptideId: number) => void
  navigateToOrderExplorer: (orderId?: string) => void
  setUpdateVersion: (version: string | null) => void
  setUpdateReady: (ready: boolean) => void
}

export const useUIStore = create<UIState>()(
  devtools(
    set => ({
      leftSidebarVisible: true,
      rightSidebarVisible: true,
      commandPaletteOpen: false,
      preferencesOpen: false,
      lastQuickPaneEntry: null,
      activeSection: 'dashboard',
      activeSubSection: 'orders',
      navigationKey: 0,
      peptideConfigTargetId: null,
      orderExplorerTargetOrderId: null,
      updateVersion: null,
      updateReady: false,

      toggleLeftSidebar: () =>
        set(
          state => ({ leftSidebarVisible: !state.leftSidebarVisible }),
          undefined,
          'toggleLeftSidebar'
        ),

      setLeftSidebarVisible: visible =>
        set(
          { leftSidebarVisible: visible },
          undefined,
          'setLeftSidebarVisible'
        ),

      toggleRightSidebar: () =>
        set(
          state => ({ rightSidebarVisible: !state.rightSidebarVisible }),
          undefined,
          'toggleRightSidebar'
        ),

      setRightSidebarVisible: visible =>
        set(
          { rightSidebarVisible: visible },
          undefined,
          'setRightSidebarVisible'
        ),

      toggleCommandPalette: () =>
        set(
          state => ({ commandPaletteOpen: !state.commandPaletteOpen }),
          undefined,
          'toggleCommandPalette'
        ),

      setCommandPaletteOpen: open =>
        set({ commandPaletteOpen: open }, undefined, 'setCommandPaletteOpen'),

      togglePreferences: () =>
        set(
          state => ({ preferencesOpen: !state.preferencesOpen }),
          undefined,
          'togglePreferences'
        ),

      setPreferencesOpen: open =>
        set({ preferencesOpen: open }, undefined, 'setPreferencesOpen'),

      setLastQuickPaneEntry: text =>
        set({ lastQuickPaneEntry: text }, undefined, 'setLastQuickPaneEntry'),

      setActiveSection: section =>
        set({ activeSection: section, activeSubSection: 'overview' }, undefined, 'setActiveSection'),

      setActiveSubSection: subSection =>
        set({ activeSubSection: subSection }, undefined, 'setActiveSubSection'),

      navigateTo: (section, subSection) =>
        set(
          state => ({ activeSection: section, activeSubSection: subSection, navigationKey: state.navigationKey + 1 }),
          undefined,
          'navigateTo'
        ),

      navigateToPeptide: peptideId =>
        set(
          state => ({
            activeSection: 'hplc-analysis',
            activeSubSection: 'peptide-config',
            peptideConfigTargetId: peptideId,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateToPeptide'
        ),

      navigateToOrderExplorer: (orderId) =>
        set(
          state => ({
            activeSection: 'accumark-tools',
            activeSubSection: 'order-explorer',
            orderExplorerTargetOrderId: orderId ?? null,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateToOrderExplorer'
        ),

      setUpdateVersion: (version) =>
        set({ updateVersion: version }, undefined, 'setUpdateVersion'),

      setUpdateReady: (ready) =>
        set({ updateReady: ready }, undefined, 'setUpdateReady'),
    }),
    {
      name: 'ui-store',
    }
  )
)
