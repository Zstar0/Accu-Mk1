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
