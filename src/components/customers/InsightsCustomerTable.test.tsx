import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { InsightsCustomerTable } from './InsightsCustomerTable'
import { row, touch } from './insights-test-fixtures'

describe('InsightsCustomerTable', () => {
  it('renders columns, sorts on header click, pages, and opens customers and tabs', async () => {
    const onSort = vi.fn()
    const onPage = vi.fn()
    const onOpen = vi.fn()
    render(
      <InsightsCustomerTable
        rows={[
          row({
            key: 'wc:2243',
            name: 'Zackary Smith',
            company: 'UMS Rx LLC',
            lifetime: '90051.25',
            testing_orders: 31,
            first_order_at: '2026-07-22T15:00:00Z',
          }),
        ]}
        total={60}
        page={2}
        pageSize={25}
        onPage={onPage}
        sort="lifetime"
        dir="desc"
        onSort={onSort}
        tz="America/Los_Angeles"
        touch={touch({ crmVisible: true, supportVisible: true })}
        onOpenCustomer={onOpen}
        emptyText="none"
      />
    )
    const tr = screen.getByText('Zackary Smith').closest('tr') as HTMLElement
    expect(tr).toHaveTextContent('UMS Rx LLC')
    expect(tr).toHaveTextContent('$90,051')
    expect(tr).toHaveTextContent('Jul 22')
    expect(tr).toHaveTextContent('31')
    expect(screen.getByText('26–26 of 60')).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: /Testing orders/ })
    )
    expect(onSort).toHaveBeenCalledWith('testing_orders')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(onPage).toHaveBeenCalledWith(3)
    await userEvent.click(screen.getByText('Zackary Smith'))
    expect(onOpen).toHaveBeenCalledWith('wc:2243')
  })

  it('shows the empty text and hides touch columns the server did not grant', () => {
    render(
      <InsightsCustomerTable
        rows={[]}
        total={0}
        page={1}
        pageSize={25}
        onPage={vi.fn()}
        sort="lifetime"
        dir="desc"
        onSort={vi.fn()}
        tz="UTC"
        touch={touch({ crmVisible: false, supportVisible: false })}
        onOpenCustomer={vi.fn()}
        emptyText="No new customers in this period"
      />
    )
    expect(
      screen.getByText('No new customers in this period')
    ).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: /Last CRM/ })).toBeNull()
  })
})
