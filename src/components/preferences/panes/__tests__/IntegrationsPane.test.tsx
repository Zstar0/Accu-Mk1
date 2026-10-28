import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/lib/api-integration-keys'
import type {
  IntegrationKeyList,
  IntegrationKeyStatus,
} from '@/lib/api-integration-keys'
import { CrmError } from '@/lib/api-crm'
import { IntegrationsPane } from '../IntegrationsPane'
import { visibleNavItems } from '../../panes'

const auth = vi.hoisted(() => ({ role: 'admin' }))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { role: auth.role } }),
}))
vi.mock('@/lib/api-integration-keys', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/api-integration-keys')
  return {
    ...actual,
    getIntegrationKeys: vi.fn(),
    saveIntegrationKey: vi.fn(),
    testIntegrationKey: vi.fn(),
    clearIntegrationKey: vi.fn(),
  }
})

const close: IntegrationKeyStatus = {
  name: 'CLOSE_API_KEY',
  label: 'Close CRM',
  source: 'env',
  last4: 'wxyz',
  updated_by_name: null,
  updated_at: null,
  undecryptable: false,
}
const list: IntegrationKeyList = { configured: true, keys: [close] }

function setup(data: IntegrationKeyList = list) {
  vi.mocked(api.getIntegrationKeys).mockResolvedValue(data)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <IntegrationsPane />
    </QueryClientProvider>
  )
}

describe('IntegrationsPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.role = 'admin'
  })

  it('shows the source and last four, never a value', async () => {
    setup()
    expect(await screen.findByText('Close CRM')).toBeInTheDocument()
    expect(screen.getByText('From server env')).toBeInTheDocument()
    expect(screen.getByText(/ends in wxyz/)).toBeInTheDocument()
  })

  it('save success clears the field and updates the row', async () => {
    setup()
    vi.mocked(api.saveIntegrationKey).mockResolvedValue({
      ...close,
      source: 'settings',
      last4: 'a3f9',
      updated_by_name: 'Forrest',
      updated_at: '2026-10-10T00:00:00Z',
    })
    await userEvent.click(
      await screen.findByRole('button', { name: 'Replace' })
    )
    await userEvent.type(
      screen.getByLabelText('New Close CRM key'),
      'close_good_key_a3f9'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save and test' }))
    await waitFor(() =>
      expect(api.saveIntegrationKey).toHaveBeenCalledWith(
        'CLOSE_API_KEY',
        'close_good_key_a3f9'
      )
    )
    expect(await screen.findByText('Saved in Settings')).toBeInTheDocument()
    expect(screen.queryByLabelText('New Close CRM key')).toBeNull()
  })

  it('a rejected key keeps the field and explains', async () => {
    setup()
    vi.mocked(api.saveIntegrationKey).mockRejectedValue(
      new CrmError(422, 'key_rejected')
    )
    await userEvent.click(
      await screen.findByRole('button', { name: 'Replace' })
    )
    const field = screen.getByLabelText('New Close CRM key')
    await userEvent.type(field, 'bad')
    await userEvent.click(screen.getByRole('button', { name: 'Save and test' }))
    expect(
      await screen.findByText('Close CRM rejected this key.')
    ).toBeInTheDocument()
    expect(field).toHaveValue('bad')
  })

  it('test reports the outcome inline', async () => {
    setup()
    vi.mocked(api.testIntegrationKey).mockResolvedValue({
      ok: true,
      outcome: 'ok',
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Working.')).toBeInTheDocument()
  })

  it('not configured disables Replace and says why', async () => {
    setup({ configured: false, keys: [close] })
    expect(
      await screen.findByText(/INTEGRATION_KEYS_SECRET is missing/)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDisabled()
  })

  it('an undecryptable key explains how to fix it', async () => {
    setup({ configured: true, keys: [{ ...close, undecryptable: true }] })
    expect(
      await screen.findByText(/saved key can't be read/)
    ).toBeInTheDocument()
  })

  it('non-admins get no data and no nav item', async () => {
    auth.role = 'standard'
    setup()
    expect(await screen.findByText(/Only admins/)).toBeInTheDocument()
    expect(api.getIntegrationKeys).not.toHaveBeenCalled()
    expect(visibleNavItems(false).some(i => i.id === 'integrations')).toBe(
      false
    )
    expect(visibleNavItems(true).some(i => i.id === 'integrations')).toBe(true)
  })
})
