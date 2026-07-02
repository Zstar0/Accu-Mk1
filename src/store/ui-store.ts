import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

// Navigation sections for main content area
export type ActiveSection =
  | 'dashboard'
  | 'senaite'
  | 'lims'
  | 'hplc-analysis'
  | 'reports'
  | 'accumark-tools'
  | 'account'
  | 'peptide-requests'
  | 'admin-clickup-users'

// Sub-sections within each main section
export type DashboardSubSection = 'orders' | 'analytics'
export type SenaiteSubSection =
  | 'samples'
  | 'event-log'
  | 'sample-details'
  | 'receive-sample'
  | 'boxes'
export type LIMSSubSection =
  | 'instruments'
  | 'methods'
  | 'peptide-config'
  | 'analysis-services'
  | 'service-groups'
export type HPLCAnalysisSubSection =
  | 'overview'
  | 'new-analysis'
  | 'import-analysis'
  | 'analysis-history'
  | 'sample-preps'
  | 'inbox'
  | 'worksheets'
  | 'worksheet-detail'
export type WorksheetSubSection = 'inbox' | 'worksheets' | 'worksheet-detail'
export type AccuMarkToolsSubSection =
  | 'overview'
  | 'order-explorer'
  | 'order-status'
  | 'customers'
  | 'customer-detail'
  | 'coa-explorer'
  | 'chromatographs'
  | 'digital-coa'
export type ReportsSubSection = 'dashboard' | 'checkin-times' | 'bottlenecks' | 'sync-debug'
export type AccountSubSection = 'profile' | 'user-management'
export type PeptideRequestsSubSection = 'list' | 'detail'
export type ActiveSubSection =
  | DashboardSubSection
  | SenaiteSubSection
  | LIMSSubSection
  | HPLCAnalysisSubSection
  | WorksheetSubSection
  | ReportsSubSection
  | AccuMarkToolsSubSection
  | AccountSubSection
  | PeptideRequestsSubSection

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
  // Deep link from the Active Boxes page: which order's receive session to
  // open (landed on the Boxing tab). ReceiveSample consumes + clears it.
  receiveBoxingTargetOrderKey: string | null
  samplePrepTargetId: number | null
  methodsTargetId: number | null
  peptideRequestTargetId: string | null
  customerDetailTargetId: number | null
  customerListPage: number
  customerSearchTerm: string
  hideTestAccounts: boolean
  // Customer detail page — Phase 30
  customerDetailTab: 'orders' | 'dashboard'
  // UX revision: three independent search slots, AND-combined server-side.
  // Each slot is the raw committed value (post-debounce) for one input. Empty
  // string = "no filter on that axis" (back-compat with debounce-flush flow).
  customerOrderSearch: {
    order_number: string
    sample_id: string
    analyte: string
  }
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
  navigateToReceiveBoxing: (orderKey: string) => void
  navigateToSamplePrep: (prepId: number) => void
  navigateToMethod: (methodId: number) => void
  navigateToPeptideRequest: (requestId: string) => void
  navigateToCustomer: (id: number) => void
  navigateToCustomers: () => void
  setCustomerListPage: (page: number) => void
  setHideTestAccounts: (hide: boolean) => void
  setSearchAndResetPage: (term: string) => void
  setCustomerDetailTab: (tab: 'orders' | 'dashboard') => void
  // Per-axis setter: writes ONE slot, leaves the other two unchanged. This is
  // how the three-input UI commits debounced values independently per axis.
  setCustomerOrderSearchField: (
    field: 'order_number' | 'sample_id' | 'analyte',
    value: string,
  ) => void
  // Clears all three slots. Used by navigateToCustomers and any explicit
  // "clear filters" affordance the UI exposes.
  setCustomerOrderSearchReset: () => void
  setUpdateVersion: (version: string | null) => void
  setUpdateReady: (ready: boolean) => void

  worksheetDrawerOpen: boolean
  activeWorksheetId: number | null
  worksheetPrepPrefill: {
    sampleId: string
    peptideId: number | null
    method: string | null
    instrumentId: number | null
    limsSubSamplePk?: number | null
    // When true, Step1SampleInfo auto-fires the SENAITE lookup for sampleId
    // once it mounts (used by the sub-sample page's "New Analysis" shortcut).
    autoLookup?: boolean
  } | null

  openWorksheetDrawer: (worksheetId?: number) => void
  closeWorksheetDrawer: () => void
  setActiveWorksheetId: (id: number | null) => void
  startPrepFromWorksheet: (prefill: {
    sampleId: string
    peptideId: number | null
    method: string | null
    instrumentId: number | null
    limsSubSamplePk?: number | null
    autoLookup?: boolean
  }) => void
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
      receiveBoxingTargetOrderKey: null,
      samplePrepTargetId: null,
      methodsTargetId: null,
      peptideRequestTargetId: null,
      customerDetailTargetId: null,
      customerListPage: 0,
      customerSearchTerm: '',
      hideTestAccounts: true,
      customerDetailTab: 'orders',
      customerOrderSearch: { order_number: '', sample_id: '', analyte: '' },
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
        set(
          { activeSection: section, activeSubSection: 'overview' },
          undefined,
          'setActiveSection'
        ),

      setActiveSubSection: subSection =>
        set({ activeSubSection: subSection }, undefined, 'setActiveSubSection'),

      navigateTo: (section, subSection) =>
        set(
          state => ({
            activeSection: section,
            activeSubSection: subSection,
            navigationKey: state.navigationKey + 1,
          }),
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

      navigateToOrderExplorer: orderId =>
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

      navigateToSample: sampleId =>
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

      navigateToReceiveBoxing: orderKey =>
        set(
          state => ({
            activeSection: 'senaite',
            activeSubSection: 'receive-sample',
            receiveBoxingTargetOrderKey: orderKey,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateToReceiveBoxing'
        ),

      navigateToSamplePrep: prepId =>
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

      navigateToMethod: methodId =>
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

      navigateToPeptideRequest: requestId =>
        set(
          state => ({
            activeSection: 'peptide-requests',
            activeSubSection: 'detail',
            peptideRequestTargetId: requestId,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateToPeptideRequest'
        ),

      navigateToCustomer: id =>
        set(
          state => ({
            activeSection: 'accumark-tools',
            activeSubSection: 'customer-detail',
            customerDetailTargetId: id,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateToCustomer'
        ),

      // Back-nav from detail view (D-11). Explicitly clears customerDetailTargetId
      // but PRESERVES customerListPage + customerSearchTerm so the user returns
      // to the exact list slice they left (D-08).
      navigateToCustomers: () =>
        set(
          state => ({
            activeSection: 'accumark-tools',
            activeSubSection: 'customers',
            customerDetailTargetId: null,
            // Phase 30 (T-30-03): reset customer-detail page state when going
            // back to the list so search/tab state never leaks between
            // customer drill-throughs.
            customerDetailTab: 'orders',
            // UX revision: clear all three search slots when navigating back
            // to the customer list — same intent as the old single-field
            // reset, just applied per-axis.
            customerOrderSearch: { order_number: '', sample_id: '', analyte: '' },
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateToCustomers'
        ),

      setCustomerListPage: page =>
        set({ customerListPage: page }, undefined, 'setCustomerListPage'),

      setHideTestAccounts: hide =>
        set({ hideTestAccounts: hide }, undefined, 'setHideTestAccounts'),

      // Atomic single-set primitive (D-12, RESEARCH §6). Writes BOTH fields in
      // one render cycle to avoid the 1-render race where the query key would
      // briefly carry (new search, old page).
      setSearchAndResetPage: term =>
        set(
          { customerSearchTerm: term, customerListPage: 0 },
          undefined,
          'setSearchAndResetPage'
        ),

      setCustomerDetailTab: tab =>
        set({ customerDetailTab: tab }, undefined, 'setCustomerDetailTab'),

      // UX revision: per-axis setter. Writes ONE slot and preserves the other
      // two via spread — this is what lets the three inputs commit
      // independently from their own per-input debounce timers without
      // stomping each other.
      setCustomerOrderSearchField: (field, value) =>
        set(
          state => ({
            customerOrderSearch: { ...state.customerOrderSearch, [field]: value },
          }),
          undefined,
          'setCustomerOrderSearchField',
        ),

      // Clears all three slots in one render cycle. Used by clear-filters
      // affordances; navigateToCustomers does the equivalent inline.
      setCustomerOrderSearchReset: () =>
        set(
          { customerOrderSearch: { order_number: '', sample_id: '', analyte: '' } },
          undefined,
          'setCustomerOrderSearchReset',
        ),

      setUpdateVersion: version =>
        set({ updateVersion: version }, undefined, 'setUpdateVersion'),

      setUpdateReady: ready =>
        set({ updateReady: ready }, undefined, 'setUpdateReady'),

      openWorksheetDrawer: worksheetId =>
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

      setActiveWorksheetId: id =>
        set({ activeWorksheetId: id }, undefined, 'setActiveWorksheetId'),

      startPrepFromWorksheet: prefill =>
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
        set(
          { worksheetPrepPrefill: null },
          undefined,
          'clearWorksheetPrepPrefill'
        ),
    }),
    {
      name: 'ui-store',
    }
  )
)
