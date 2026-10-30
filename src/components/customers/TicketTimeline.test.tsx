import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SupportEntry } from '@/lib/api-support'
import { TicketTimeline } from './TicketTimeline'

const base = {
  author_kind: 'customer' as const,
  internal: false,
  subject: null,
  author_avatar_url: null,
  automated: false,
  email_to: null,
  email_from: null,
  markdown: null,
  event: null,
}
const entries: SupportEntry[] = [
  {
    ...base,
    id: 'e1',
    at: '2026-09-15T10:00:00Z',
    kind: 'form',
    author: 'Lilia Billones',
    subject: 'Contact form',
    text: 'Can the lot code be changed?',
  },
  {
    ...base,
    id: 'e2',
    at: '2026-09-15T10:01:00Z',
    kind: 'email',
    author: null,
    author_kind: 'system',
    automated: true,
    subject: 'Re: Contact form',
    text: 'We got your message',
  },
  {
    ...base,
    id: 'e3',
    at: '2026-09-15T11:00:00Z',
    kind: 'event',
    author: 'Lauren Hamilton',
    author_kind: 'agent',
    text: 'Marked done by Lauren Hamilton',
    event: {
      icon: 'status',
      actor: 'Lauren Hamilton',
      text: 'changed status to Done',
    },
  },
  {
    ...base,
    id: 'e4',
    at: '2026-09-16T09:00:00Z',
    kind: 'note',
    author: 'Forrest Parker',
    author_kind: 'agent',
    internal: true,
    text: '@Lauren Hamilton did we ever receive the 10ml?',
  },
  {
    ...base,
    id: 'e5',
    at: '2026-09-16T09:30:00Z',
    kind: 'email',
    author: 'Lauren Hamilton',
    author_kind: 'agent',
    subject: 'Re: Contact form',
    email_to: 'lilia@example.com',
    email_from: 'support@accumarklabs.com',
    text: 'We can not change the LOT code.',
  },
  {
    ...base,
    id: 'e6',
    at: '2026-09-16T10:00:00Z',
    kind: 'event',
    author: 'Forrest Parker',
    author_kind: 'agent',
    text: 'x',
    event: {
      icon: 'assign',
      actor: 'Forrest Parker',
      text: 'assigned Lauren Hamilton',
    },
  },
]

function setup() {
  render(
    <TicketTimeline
      entries={entries}
      customerFirstName="Lilia"
      viewerName="Forrest Parker"
    />
  )
}

describe('TicketTimeline', () => {
  it('splits days with Plain-style dividers', () => {
    setup()
    expect(screen.getByText('Tue, Sep 15, 2026')).toBeInTheDocument()
    expect(screen.getByText('Wed, Sep 16, 2026')).toBeInTheDocument()
  })

  it('picks the card for each kind of entry', () => {
    setup()
    expect(
      screen.getByText('Can the lot code be changed?').closest('[data-card]')
    ).toHaveAttribute('data-card', 'customer')
    expect(
      screen.getByText('We can not change the LOT code.').closest('[data-card]')
    ).toHaveAttribute('data-card', 'team')
    expect(
      screen.getByText(/did we ever receive/).closest('[data-card]')
    ).toHaveAttribute('data-card', 'note')
    expect(
      screen.getByText('to: lilia@example.com, from: support@accumarklabs.com')
    ).toBeInTheDocument()
  })

  it('renders mention chips and collapses automated mail', async () => {
    setup()
    expect(screen.getByText('@Lauren Hamilton')).toHaveAttribute('data-mention')
    expect(screen.getByText('Not visible to Lilia')).toBeInTheDocument()
    expect(
      screen.getByText('This email was sent automatically')
    ).toBeInTheDocument()
    expect(screen.queryByText('We got your message')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show message' }))
    expect(screen.getByText('We got your message')).toBeInTheDocument()
  })

  it('writes events as one line and says You for the viewer', () => {
    setup()
    expect(screen.getAllByText('Lauren Hamilton').length).toBeGreaterThan(0)
    expect(screen.getByText(/changed status to Done/)).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByText(/assigned Lauren Hamilton/)).toBeInTheDocument()
  })
})
