import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { it, expect, vi } from 'vitest'
import { DataSourcePane } from '@/components/preferences/panes/DataSourcePane'
import * as api from '@/lib/api'

vi.mock('@/store/auth-store', () => ({ useAuthStore: (sel: any) => sel({ user: { role: 'admin' } }) }))

function renderPane() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><DataSourcePane /></QueryClientProvider>)
}

it('saves the per-page global map', async () => {
  vi.spyOn(api, 'getSettings').mockResolvedValue([
    { key: 'registry_read_source', value: '{"sample_details":"senaite","samples_list":"senaite"}' } as api.Setting,
  ])
  const put = vi.spyOn(api, 'updateSetting').mockResolvedValue({} as api.Setting)
  renderPane()
  await waitFor(() => screen.getByText(/sample details/i))
  await userEvent.click(screen.getByRole('button', { name: /sample details:.*Accu-Mk1/i }))
  await userEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(put).toHaveBeenCalledWith('registry_read_source', expect.stringContaining('"sample_details":"mk1"')))
})

it('renders the COA generation section with both source buttons', async () => {
  vi.spyOn(api, 'getSettings').mockResolvedValue([
    { key: 'registry_read_source', value: '{"sample_details":"senaite","samples_list":"senaite"}' } as api.Setting,
  ])
  renderPane()
  expect(await screen.findByText('COA generation')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'COA generation: Accu-Mk1' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'COA generation: SENAITE' })).toBeInTheDocument()
})

it('saving includes coa_generation in the written map', async () => {
  vi.spyOn(api, 'getSettings').mockResolvedValue([
    { key: 'registry_read_source', value: '{"sample_details":"senaite","samples_list":"senaite"}' } as api.Setting,
  ])
  // vi.spyOn on an already-mocked fn (updateSetting was spied by an earlier
  // test in this file) reuses the same mock instance rather than creating a
  // fresh one, so mock.calls would otherwise carry over prior tests' calls.
  // mockClear() resets the call log without touching mockResolvedValue.
  const put = vi.spyOn(api, 'updateSetting').mockResolvedValue({} as api.Setting)
  put.mockClear()
  renderPane()
  await userEvent.click(await screen.findByRole('button', { name: 'COA generation: Accu-Mk1' }))
  await userEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(put).toHaveBeenCalled())
  const written = put.mock.calls[0]?.[1]
  expect(JSON.parse(written as string)).toMatchObject({ coa_generation: 'mk1' })
})

it('saving a page toggle preserves an existing coa_generation value', async () => {
  vi.spyOn(api, 'getSettings').mockResolvedValue([
    {
      key: 'registry_read_source',
      value: JSON.stringify({ sample_details: 'senaite', coa_generation: 'mk1' }),
    } as api.Setting,
  ])
  const put = vi.spyOn(api, 'updateSetting').mockResolvedValue({} as api.Setting)
  put.mockClear()
  renderPane()
  await userEvent.click(await screen.findByRole('button', { name: 'Sample details: Accu-Mk1' }))
  await userEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(put).toHaveBeenCalled())
  const written = put.mock.calls[0]?.[1]
  expect(JSON.parse(written as string)).toMatchObject({ sample_details: 'mk1', coa_generation: 'mk1' })
})
