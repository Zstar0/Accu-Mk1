// Real i18n resources, so the assertions below read the English copy.
import '@/i18n/config'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CrmError } from '@/lib/api-crm'
import { decidePermission } from '@/lib/ai-chat-api'
import { useAiChatStore, type ApprovalCard as Card } from '../chat-store'
import { ApprovalCard } from '../ApprovalCard'

import type * as Api from '@/lib/ai-chat-api'

vi.mock('@/lib/ai-chat-api', async importOriginal => ({
  ...(await importOriginal<typeof Api>()),
  decidePermission: vi.fn(),
}))

const decide = vi.mocked(decidePermission)
const CANNOT_SHOW =
  'Not all of this can be shown here, so it can only be denied.'

const card = (over: Partial<Card> = {}): Card => ({
  permission_id: 'p1',
  source: 'agent',
  title: 'Run ls',
  detail: 'ls -la /srv',
  can_allow: true,
  hidden: false,
  chatId: 7,
  ...over,
})

const buttons = () => ({
  allow: screen.queryByRole('button', { name: 'Allow once' }),
  deny: screen.queryByRole('button', { name: 'Deny' }),
})

beforeEach(() => {
  useAiChatStore.getState().reset()
  decide.mockReset()
})

describe('ApprovalCard', () => {
  it('shows the title and the detail as plain text', () => {
    render(
      <ApprovalCard
        card={card({
          title: '<b>bold</b> rm',
          detail: '<img src=x onerror=1>',
        })}
      />
    )
    expect(screen.getByText('<b>bold</b> rm')).toBeInTheDocument()
    // The detail sits in a <pre>, as text.
    const pre = screen.getByText('<img src=x onerror=1>')
    expect(pre.tagName).toBe('PRE')
    expect(document.querySelector('b, img')).toBeNull()
  })

  it('hides Allow once when can_allow is false', () => {
    render(<ApprovalCard card={card({ can_allow: false })} />)
    expect(buttons().allow).toBeNull()
    expect(buttons().deny).toBeEnabled()
    // The agent offered no allow_once: nothing is hidden, so no reason to give.
    expect(screen.queryByText(CANNOT_SHOW)).toBeNull()
  })

  it('says why Allow once is missing when part of the request cannot be shown', () => {
    render(
      <ApprovalCard
        card={card({
          can_allow: false,
          hidden: true,
          detail: 'x\n\n5000 more characters not shown.',
        })}
      />
    )
    expect(buttons().allow).toBeNull()
    expect(buttons().deny).toBeEnabled()
    expect(screen.getByText(CANNOT_SHOW)).toBeInTheDocument()
  })

  it('scrolls a long title and detail, and keeps the buttons outside them', () => {
    const long = 'rm -rf /srv '.repeat(1000)
    render(<ApprovalCard card={card({ title: `t ${long}`, detail: long })} />)
    for (const text of [`t ${long}`, long]) {
      const box = screen.getByText(
        (_, el) => el?.textContent === text && el.children.length === 0
      )
      expect(box.className).toMatch(/\bmax-h-\d+\b/)
      expect(box.className).toMatch(/\boverflow-y-auto\b/)
      expect(box.className).toMatch(/\bwhitespace-pre-wrap\b/)
      expect(box).toHaveAttribute('tabindex', '0')
      expect(box.contains(buttons().allow)).toBe(false)
      expect(box.contains(buttons().deny)).toBe(false)
    }
  })

  it('offers Allow once and Deny when can_allow is true', () => {
    render(<ApprovalCard card={card()} />)
    expect(buttons().allow).toBeEnabled()
    expect(buttons().deny).toBeEnabled()
  })

  it('sends allow, then keeps the buttons off and does not claim the outcome', async () => {
    decide.mockResolvedValue({ decision: 'allow' })
    render(<ApprovalCard card={card()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }))

    expect(decide).toHaveBeenCalledWith(7, 'p1', 'allow')
    expect(await screen.findByText('Sent.')).toBeInTheDocument()
    // A 200 only means "accepted": Stop can still turn it into `cancelled`.
    expect(buttons().allow).toBeDisabled()
    expect(buttons().deny).toBeDisabled()
    expect(document.body.textContent).not.toMatch(/allowed|denied|approved/i)
  })

  it('sends deny with the decision word only', async () => {
    decide.mockResolvedValue({ decision: 'deny' })
    render(<ApprovalCard card={card()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(decide).toHaveBeenCalledWith(7, 'p1', 'deny')
    expect(await screen.findByText('Sent.')).toBeInTheDocument()
  })

  it('disables both buttons while the request is in flight', async () => {
    let finish: (v: { decision: string }) => void = () => undefined
    decide.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )
    render(<ApprovalCard card={card()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(buttons().allow).toBeDisabled()
    expect(buttons().deny).toBeDisabled()
    finish({ decision: 'allow' })
    expect(await screen.findByText('Sent.')).toBeInTheDocument()
  })

  it('shows Already decided. on 409 permission_decided, and Dismiss removes the card', async () => {
    useAiChatStore.setState({ approvals: { p1: card() } })
    decide.mockRejectedValue(new CrmError(409, 'permission_decided'))
    render(<ApprovalCard card={card()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }))

    expect(await screen.findByText('Already decided.')).toBeInTheDocument()
    expect(buttons().allow).toBeDisabled()
    expect(buttons().deny).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(useAiChatStore.getState().approvals).toEqual({})
  })

  it('shows This request expired. on 404, and Dismiss removes the card', async () => {
    useAiChatStore.setState({ approvals: { p1: card() } })
    decide.mockRejectedValue(new CrmError(404, 'permission_not_found'))
    render(<ApprovalCard card={card()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))

    expect(await screen.findByText('This request expired.')).toBeInTheDocument()
    expect(buttons().deny).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(useAiChatStore.getState().approvals).toEqual({})
  })

  it('re-enables the buttons on 409 allow_not_offered', async () => {
    decide.mockRejectedValue(new CrmError(409, 'allow_not_offered'))
    render(<ApprovalCard card={card()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }))

    expect(
      await screen.findByText('Could not send that. Try again.')
    ).toBeInTheDocument()
    expect(buttons().allow).toBeEnabled()
    expect(buttons().deny).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })

  it('re-enables the buttons on a network failure', async () => {
    decide.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<ApprovalCard card={card()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(
      await screen.findByText('Could not send that. Try again.')
    ).toBeInTheDocument()
    expect(buttons().deny).toBeEnabled()
  })
})
