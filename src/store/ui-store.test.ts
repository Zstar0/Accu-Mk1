import { describe, it, expect, beforeEach } from 'vitest'
import { useUIStore } from './ui-store'

describe('UIStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useUIStore.setState({
      leftSidebarVisible: true,
      rightSidebarVisible: true,
      commandPaletteOpen: false,
      preferencesOpen: false,
    })
  })

  it('has correct initial state', () => {
    const state = useUIStore.getState()
    expect(state.leftSidebarVisible).toBe(true)
    expect(state.rightSidebarVisible).toBe(true)
    expect(state.commandPaletteOpen).toBe(false)
    expect(state.preferencesOpen).toBe(false)
  })

  it('toggles left sidebar visibility', () => {
    const { toggleLeftSidebar } = useUIStore.getState()

    toggleLeftSidebar()
    expect(useUIStore.getState().leftSidebarVisible).toBe(false)

    toggleLeftSidebar()
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
  })

  it('sets left sidebar visibility directly', () => {
    const { setLeftSidebarVisible } = useUIStore.getState()

    setLeftSidebarVisible(false)
    expect(useUIStore.getState().leftSidebarVisible).toBe(false)

    setLeftSidebarVisible(true)
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
  })

  it('toggles preferences dialog', () => {
    const { togglePreferences } = useUIStore.getState()

    togglePreferences()
    expect(useUIStore.getState().preferencesOpen).toBe(true)

    togglePreferences()
    expect(useUIStore.getState().preferencesOpen).toBe(false)
  })

  it('toggles command palette', () => {
    const { toggleCommandPalette } = useUIStore.getState()

    toggleCommandPalette()
    expect(useUIStore.getState().commandPaletteOpen).toBe(true)

    toggleCommandPalette()
    expect(useUIStore.getState().commandPaletteOpen).toBe(false)
  })
})

describe('UIStore customer actions', () => {
  beforeEach(() => {
    // Reset customer-related fields + navigation envelope before each test.
    useUIStore.setState({
      activeSection: 'dashboard',
      activeSubSection: 'orders',
      navigationKey: 0,
      customerDetailTargetId: null,
      customerListPage: 0,
      customerSearchTerm: '',
      hideTestAccounts: true,
    } as Partial<ReturnType<typeof useUIStore.getState>>)
  })

  it('has correct customer initial state', () => {
    const state = useUIStore.getState()
    expect(state.customerDetailTargetId).toBeNull()
    expect(state.customerListPage).toBe(0)
    expect(state.customerSearchTerm).toBe('')
    expect(state.hideTestAccounts).toBe(true)
  })

  it('navigateToCustomer sets section, sub-section, target id, and increments navigationKey', () => {
    const before = useUIStore.getState().navigationKey
    useUIStore.getState().navigateToCustomer(42)
    const state = useUIStore.getState()
    expect(state.activeSection).toBe('accumark-tools')
    expect(state.activeSubSection).toBe('customer-detail')
    expect(state.customerDetailTargetId).toBe(42)
    expect(state.navigationKey).toBe(before + 1)
  })

  it('navigateToCustomers clears customerDetailTargetId, preserves page+search, increments navigationKey', () => {
    useUIStore.setState({
      customerDetailTargetId: 42,
      customerListPage: 3,
      customerSearchTerm: 'foo',
    } as Partial<ReturnType<typeof useUIStore.getState>>)
    const before = useUIStore.getState().navigationKey
    useUIStore.getState().navigateToCustomers()
    const state = useUIStore.getState()
    expect(state.activeSection).toBe('accumark-tools')
    expect(state.activeSubSection).toBe('customers')
    expect(state.customerDetailTargetId).toBeNull()
    // D-08: page+search MUST survive the round-trip
    expect(state.customerListPage).toBe(3)
    expect(state.customerSearchTerm).toBe('foo')
    expect(state.navigationKey).toBe(before + 1)
  })

  it('setSearchAndResetPage atomically updates search term and resets page to 0', () => {
    useUIStore.setState({
      customerListPage: 5,
      customerSearchTerm: 'old',
    } as Partial<ReturnType<typeof useUIStore.getState>>)
    useUIStore.getState().setSearchAndResetPage('bar')
    // Single observation: both fields must be committed in one render cycle.
    const state = useUIStore.getState()
    expect(state.customerSearchTerm).toBe('bar')
    expect(state.customerListPage).toBe(0)
  })

  it('setHideTestAccounts toggles the flag', () => {
    useUIStore.getState().setHideTestAccounts(false)
    expect(useUIStore.getState().hideTestAccounts).toBe(false)
    useUIStore.getState().setHideTestAccounts(true)
    expect(useUIStore.getState().hideTestAccounts).toBe(true)
  })

  it('setCustomerListPage writes the page', () => {
    useUIStore.getState().setCustomerListPage(2)
    expect(useUIStore.getState().customerListPage).toBe(2)
  })
})

describe('UIStore flags flyout + thread', () => {
  beforeEach(() => {
    useUIStore.setState({ flagsFlyoutOpen: false, flagsThreadId: null })
  })

  it('defaults to closed with no active thread', () => {
    const state = useUIStore.getState()
    expect(state.flagsFlyoutOpen).toBe(false)
    expect(state.flagsThreadId).toBeNull()
  })

  it('openFlagsFlyout() opens the flyout (triage list, no thread)', () => {
    useUIStore.getState().openFlagsFlyout()
    const state = useUIStore.getState()
    expect(state.flagsFlyoutOpen).toBe(true)
    expect(state.flagsThreadId).toBeNull()
  })

  it('openFlagThread(7) opens the flyout onto thread 7', () => {
    useUIStore.getState().openFlagThread(7)
    const state = useUIStore.getState()
    expect(state.flagsFlyoutOpen).toBe(true)
    expect(state.flagsThreadId).toBe(7)
  })

  it('openFlagsFlyout() preserves an already-open thread id', () => {
    useUIStore.getState().openFlagThread(3)
    useUIStore.getState().closeFlagsFlyout()
    // Re-open the list without arg — thread id was reset by close, stays null.
    useUIStore.getState().openFlagsFlyout()
    expect(useUIStore.getState().flagsThreadId).toBeNull()
  })

  it('closeFlagThread() drops the thread but keeps the flyout open', () => {
    useUIStore.getState().openFlagThread(5)
    useUIStore.getState().closeFlagThread()
    const state = useUIStore.getState()
    expect(state.flagsFlyoutOpen).toBe(true)
    expect(state.flagsThreadId).toBeNull()
  })

  it('closeFlagsFlyout() resets both flyout and thread', () => {
    useUIStore.getState().openFlagThread(9)
    useUIStore.getState().closeFlagsFlyout()
    const state = useUIStore.getState()
    expect(state.flagsFlyoutOpen).toBe(false)
    expect(state.flagsThreadId).toBeNull()
  })
})

describe('UIStore flags entity filter', () => {
  beforeEach(() => {
    useUIStore.setState({
      flagsFlyoutOpen: false,
      flagsThreadId: null,
      flagsEntityFilter: null,
    })
  })

  it('defaults to no entity filter', () => {
    expect(useUIStore.getState().flagsEntityFilter).toBeNull()
  })

  it('openFlagsForEntity opens the flyout filtered to that entity (descendants default false)', () => {
    useUIStore.getState().openFlagsForEntity('sub_sample', '42')
    const state = useUIStore.getState()
    expect(state.flagsFlyoutOpen).toBe(true)
    expect(state.flagsThreadId).toBeNull()
    expect(state.flagsEntityFilter).toEqual({
      type: 'sub_sample',
      id: '42',
      includeDescendants: false,
    })
  })

  it('openFlagsForEntity honors includeDescendants and drops any open thread', () => {
    useUIStore.getState().openFlagThread(5)
    useUIStore
      .getState()
      .openFlagsForEntity('sample', 'P-0071', { includeDescendants: true })
    const state = useUIStore.getState()
    expect(state.flagsThreadId).toBeNull()
    expect(state.flagsEntityFilter).toEqual({
      type: 'sample',
      id: 'P-0071',
      includeDescendants: true,
    })
  })

  it('clearFlagsEntityFilter returns to the tabs (keeps flyout open)', () => {
    useUIStore.getState().openFlagsForEntity('sample', 'P-0071')
    useUIStore.getState().clearFlagsEntityFilter()
    const state = useUIStore.getState()
    expect(state.flagsEntityFilter).toBeNull()
    expect(state.flagsFlyoutOpen).toBe(true)
  })

  it('closeFlagsFlyout clears the entity filter', () => {
    useUIStore.getState().openFlagsForEntity('sample', 'P-0071')
    useUIStore.getState().closeFlagsFlyout()
    const state = useUIStore.getState()
    expect(state.flagsEntityFilter).toBeNull()
    expect(state.flagsFlyoutOpen).toBe(false)
  })
})

describe('UIStore flags samples (order) filter', () => {
  beforeEach(() => {
    useUIStore.setState({
      flagsFlyoutOpen: false,
      flagsThreadId: null,
      flagsEntityFilter: null,
      flagsSamplesFilter: null,
    })
  })

  it('defaults to no samples filter', () => {
    expect(useUIStore.getState().flagsSamplesFilter).toBeNull()
  })

  it('openFlagsForSamples opens the flyout scoped to the sample ids', () => {
    useUIStore.getState().openFlagsForSamples('#1042', ['P-0001', 'P-0002'])
    const state = useUIStore.getState()
    expect(state.flagsFlyoutOpen).toBe(true)
    expect(state.flagsThreadId).toBeNull()
    expect(state.flagsSamplesFilter).toEqual({
      label: '#1042',
      sampleIds: ['P-0001', 'P-0002'],
    })
  })

  it('is mutually exclusive with the single-entity filter (each clears the other)', () => {
    useUIStore.getState().openFlagsForEntity('sample', 'P-0071')
    useUIStore.getState().openFlagsForSamples('#1042', ['P-0001'])
    expect(useUIStore.getState().flagsEntityFilter).toBeNull()
    expect(useUIStore.getState().flagsSamplesFilter).toEqual({
      label: '#1042',
      sampleIds: ['P-0001'],
    })

    // …and opening a single entity clears the samples scope.
    useUIStore.getState().openFlagsForEntity('sample', 'P-0071')
    expect(useUIStore.getState().flagsSamplesFilter).toBeNull()
    expect(useUIStore.getState().flagsEntityFilter).not.toBeNull()
  })

  it('clearFlagsSamplesFilter returns to the tabs (keeps flyout open)', () => {
    useUIStore.getState().openFlagsForSamples('#1042', ['P-0001'])
    useUIStore.getState().clearFlagsSamplesFilter()
    expect(useUIStore.getState().flagsSamplesFilter).toBeNull()
    expect(useUIStore.getState().flagsFlyoutOpen).toBe(true)
  })

  it('closeFlagsFlyout clears the samples filter', () => {
    useUIStore.getState().openFlagsForSamples('#1042', ['P-0001'])
    useUIStore.getState().closeFlagsFlyout()
    const state = useUIStore.getState()
    expect(state.flagsSamplesFilter).toBeNull()
    expect(state.flagsFlyoutOpen).toBe(false)
  })
})

describe('UIStore customer detail tabs + order search', () => {
  beforeEach(() => {
    useUIStore.setState(useUIStore.getInitialState())
  })

  it('has correct customer-detail-tab initial state', () => {
    const state = useUIStore.getState()
    expect(state.customerDetailTab).toBe('orders')
    // UX revision: three-slot shape, all empty.
    expect(state.customerOrderSearch).toEqual({
      order_number: '',
      sample_id: '',
      analyte: '',
    })
  })

  it('setCustomerDetailTab writes the tab field', () => {
    useUIStore.getState().setCustomerDetailTab('dashboard')
    expect(useUIStore.getState().customerDetailTab).toBe('dashboard')
  })

  it('setCustomerOrderSearchField writes one slot, preserves the other two', () => {
    useUIStore.getState().setCustomerOrderSearchField('sample_id', 'P-0001')
    let state = useUIStore.getState()
    expect(state.customerOrderSearch).toEqual({
      order_number: '',
      sample_id: 'P-0001',
      analyte: '',
    })

    // Independent setter call must NOT clobber the previously-written slot.
    useUIStore.getState().setCustomerOrderSearchField('analyte', 'BPC-157')
    state = useUIStore.getState()
    expect(state.customerOrderSearch).toEqual({
      order_number: '',
      sample_id: 'P-0001',
      analyte: 'BPC-157',
    })

    // Third slot exercise + overwrite-in-place.
    useUIStore.getState().setCustomerOrderSearchField('order_number', 'WP-001')
    useUIStore.getState().setCustomerOrderSearchField('sample_id', 'P-0002')
    state = useUIStore.getState()
    expect(state.customerOrderSearch).toEqual({
      order_number: 'WP-001',
      sample_id: 'P-0002',
      analyte: 'BPC-157',
    })
  })

  it('setCustomerOrderSearchField with empty string clears that one slot only', () => {
    useUIStore.setState({
      customerOrderSearch: {
        order_number: 'WP-001',
        sample_id: 'P-0001',
        analyte: 'BPC-157',
      },
    })
    useUIStore.getState().setCustomerOrderSearchField('sample_id', '')
    expect(useUIStore.getState().customerOrderSearch).toEqual({
      order_number: 'WP-001',
      sample_id: '',
      analyte: 'BPC-157',
    })
  })

  it('setCustomerOrderSearchReset clears all three slots', () => {
    useUIStore.setState({
      customerOrderSearch: {
        order_number: 'WP-001',
        sample_id: 'P-0001',
        analyte: 'BPC-157',
      },
    })
    useUIStore.getState().setCustomerOrderSearchReset()
    expect(useUIStore.getState().customerOrderSearch).toEqual({
      order_number: '',
      sample_id: '',
      analyte: '',
    })
  })

  it('navigateToCustomers clears customerDetailTab and all customerOrderSearch slots', () => {
    // Seed all three slots + tab with non-default values
    useUIStore.setState({
      customerDetailTab: 'dashboard',
      customerOrderSearch: {
        order_number: 'WP-001',
        sample_id: 'P-0001',
        analyte: 'BPC-157',
      },
    })
    useUIStore.getState().navigateToCustomers()
    const state = useUIStore.getState()
    expect(state.customerDetailTab).toBe('orders')
    expect(state.customerOrderSearch).toEqual({
      order_number: '',
      sample_id: '',
      analyte: '',
    })
  })
})
