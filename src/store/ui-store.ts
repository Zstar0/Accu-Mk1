import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

// Navigation sections for main content area
export type ActiveSection = 'dashboard' | 'lab-operations' | 'hplc-analysis' | 'accumark-tools' | 'account'

// Sub-sections within each main section
export type LabOperationsSubSection = 'chromatographs' | 'sample-intake'
export type HPLCAnalysisSubSection = 'overview' | 'new-analysis' | 'peptide-config' | 'analysis-history'
export type AccuMarkToolsSubSection = 'overview' | 'order-explorer' | 'coa-explorer'
export type AccountSubSection = 'change-password' | 'user-management'
export type ActiveSubSection = LabOperationsSubSection | HPLCAnalysisSubSection | AccuMarkToolsSubSection | AccountSubSection

interface UIState {
  leftSidebarVisible: boolean
  rightSidebarVisible: boolean
  commandPaletteOpen: boolean
  preferencesOpen: boolean
  lastQuickPaneEntry: string | null
  activeSection: ActiveSection
  activeSubSection: ActiveSubSection
  peptideConfigTargetId: number | null
  orderExplorerTargetOrderId: string | null

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
      activeSubSection: 'overview',
      peptideConfigTargetId: null,
      orderExplorerTargetOrderId: null,

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
        set({ activeSection: section, activeSubSection: subSection }, undefined, 'navigateTo'),

      navigateToPeptide: peptideId =>
        set({
          activeSection: 'hplc-analysis',
          activeSubSection: 'peptide-config',
          peptideConfigTargetId: peptideId,
        }, undefined, 'navigateToPeptide'),

      navigateToOrderExplorer: (orderId) =>
        set({
          activeSection: 'accumark-tools',
          activeSubSection: 'order-explorer',
          orderExplorerTargetOrderId: orderId ?? null,
        }, undefined, 'navigateToOrderExplorer'),
    }),
    {
      name: 'ui-store',
    }
  )
)
