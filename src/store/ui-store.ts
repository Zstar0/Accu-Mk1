import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

// Navigation sections for main content area
export type ActiveSection = 'dashboard' | 'senaite' | 'lims' | 'hplc-analysis' | 'reports' | 'accumark-tools' | 'account'

// Sub-sections within each main section
export type DashboardSubSection = 'orders' | 'analytics'
export type SenaiteSubSection = 'samples' | 'event-log' | 'sample-details' | 'receive-sample'
export type LIMSSubSection = 'instruments' | 'methods' | 'peptide-config' | 'analysis-services' | 'service-groups'
export type HPLCAnalysisSubSection = 'overview' | 'new-analysis' | 'import-analysis' | 'analysis-history' | 'sample-preps' | 'inbox' | 'worksheets' | 'worksheet-detail'
export type WorksheetSubSection = 'inbox' | 'worksheets' | 'worksheet-detail'
export type AccuMarkToolsSubSection = 'overview' | 'order-explorer' | 'order-status' | 'coa-explorer' | 'chromatographs' | 'digital-coa'
export type ReportsSubSection = 'dashboard' | 'sync-debug'
export type AccountSubSection = 'profile' | 'user-management'
export type ActiveSubSection = DashboardSubSection | SenaiteSubSection | LIMSSubSection | HPLCAnalysisSubSection | WorksheetSubSection | ReportsSubSection | AccuMarkToolsSubSection | AccountSubSection

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
  sampleDetailsTargetId: string | null
  samplePrepTargetId: number | null
  methodsTargetId: number | null
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
  navigateToSample: (sampleId: string) => void
  navigateToSamplePrep: (prepId: number) => void
  navigateToMethod: (methodId: number) => void
  setUpdateVersion: (version: string | null) => void
  setUpdateReady: (ready: boolean) => void

  worksheetDrawerOpen: boolean
  activeWorksheetId: number | null
  worksheetPrepPrefill: { sampleId: string; peptideId: number | null; method: string | null; instrumentId: number | null } | null

  openWorksheetDrawer: (worksheetId?: number) => void
  closeWorksheetDrawer: () => void
  setActiveWorksheetId: (id: number | null) => void
  startPrepFromWorksheet: (prefill: { sampleId: string; peptideId: number | null; method: string | null; instrumentId: number | null }) => void
  clearWorksheetPrepPrefill: () => void
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
      sampleDetailsTargetId: null,
      samplePrepTargetId: null,
      methodsTargetId: null,
      updateVersion: null,
      updateReady: false,
      worksheetDrawerOpen: false,
      activeWorksheetId: null,
      worksheetPrepPrefill: null,

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
            activeSection: 'lims',
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

      navigateToSample: (sampleId) =>
        set(
          state => ({
            activeSection: 'senaite',
            activeSubSection: 'sample-details',
            sampleDetailsTargetId: sampleId,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateToSample'
        ),

      navigateToSamplePrep: (prepId) =>
        set(
          state => ({
            activeSection: 'hplc-analysis',
            activeSubSection: 'sample-preps',
            samplePrepTargetId: prepId,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateToSamplePrep'
        ),

      navigateToMethod: (methodId) =>
        set(
          state => ({
            activeSection: 'lims',
            activeSubSection: 'methods',
            methodsTargetId: methodId,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateToMethod'
        ),

      setUpdateVersion: (version) =>
        set({ updateVersion: version }, undefined, 'setUpdateVersion'),

      setUpdateReady: (ready) =>
        set({ updateReady: ready }, undefined, 'setUpdateReady'),

      openWorksheetDrawer: (worksheetId) =>
        set(
          state => ({
            worksheetDrawerOpen: true,
            activeWorksheetId: worksheetId ?? state.activeWorksheetId,
          }),
          undefined,
          'openWorksheetDrawer'
        ),

      closeWorksheetDrawer: () =>
        set({ worksheetDrawerOpen: false }, undefined, 'closeWorksheetDrawer'),

      setActiveWorksheetId: (id) =>
        set({ activeWorksheetId: id }, undefined, 'setActiveWorksheetId'),

      startPrepFromWorksheet: (prefill) =>
        set(
          state => ({
            worksheetPrepPrefill: prefill,
            worksheetDrawerOpen: false,
            activeSection: 'hplc-analysis' as const,
            activeSubSection: 'new-analysis' as const,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'startPrepFromWorksheet'
        ),

      clearWorksheetPrepPrefill: () =>
        set({ worksheetPrepPrefill: null }, undefined, 'clearWorksheetPrepPrefill'),
    }),
    {
      name: 'ui-store',
    }
  )
)
