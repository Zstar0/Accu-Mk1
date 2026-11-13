import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map(),
  nameForUser: (_m: unknown, id: number | null) =>
    id == null ? '—' : `User ${id}`,
}))
const fetchUrl = vi.hoisted(() => vi.fn())
vi.mock('@/lib/flags-api', async orig => ({
  ...(await orig()),
  fetchFlagAttachmentUrl: fetchUrl,
}))

describe('CommentBody', () => {
  beforeEach(() => fetchUrl.mockReset())

  it('renders markdown and resolves attachment blob src', async () => {
    fetchUrl.mockResolvedValue('blob:abc')
    const { CommentBody } = await import('@/components/flags/CommentBody')
    render(
      <CommentBody
        body="**hi** {attachment:5}"
        mentions={[]}
        users={new Map()}
      />
    )
    expect(document.querySelector('strong')?.textContent).toBe('hi')
    await waitFor(() =>
      expect(
        document.querySelector('img.flag-attach')?.getAttribute('src')
      ).toBe('blob:abc')
    )
    expect(fetchUrl).toHaveBeenCalledWith(5)
  })

  it('wraps long unbroken tokens: the body container carries an anywhere overflow-wrap', async () => {
    fetchUrl.mockResolvedValue('')
    const { CommentBody } = await import('@/components/flags/CommentBody')
    const longUrl = `https://example.com/${'a'.repeat(300)}`
    render(<CommentBody body={longUrl} mentions={[]} users={new Map()} />)
    const container = document.querySelector('.flag-body') as HTMLElement
    // jsdom can't prove visual wrapping, so assert the wrap utility is present
    // (paired with a visual-pass eyeball of the bubble/flyout).
    expect(container.className).toContain('[overflow-wrap:anywhere]')
  })

  it('opens a lightbox when an attachment image is clicked', async () => {
    fetchUrl.mockResolvedValue('blob:abc')
    const { CommentBody } = await import('@/components/flags/CommentBody')
    render(
      <CommentBody body="{attachment:5}" mentions={[]} users={new Map()} />
    )
    const img = await waitFor(() => {
      const el = document.querySelector('img.flag-attach') as HTMLImageElement
      expect(el.getAttribute('src')).toBe('blob:abc')
      return el
    })
    fireEvent.click(img)
    expect(
      screen.getByRole('dialog', { name: /attachment/i })
    ).toBeInTheDocument()
  })

  // A transformed or contained ancestor (the slide-in flyout, the Tasks page
  // root) becomes the containing block for `position: fixed`, so a lightbox
  // rendered inside the comment was trapped in the message area (prod 10-30).
  it('opens the lightbox outside the thread, full screen, and Escape closes it', async () => {
    fetchUrl.mockResolvedValue('blob:abc')
    const { CommentBody } = await import('@/components/flags/CommentBody')
    render(
      <div data-testid="thread" style={{ transform: 'translateX(0)' }}>
        <CommentBody body="{attachment:5}" mentions={[]} users={new Map()} />
      </div>
    )
    const img = await waitFor(() => {
      const el = document.querySelector('img.flag-attach') as HTMLImageElement
      expect(el.getAttribute('src')).toBe('blob:abc')
      return el
    })
    fireEvent.click(img)
    const dialog = screen.getByRole('dialog', { name: /attachment/i })
    expect(screen.getByTestId('thread')).not.toContainElement(dialog)
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('blob:abc')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  // A deleted (404) or still-loading attachment keeps a src-less placeholder;
  // clicking it must not open an empty full-screen dialog.
  it('does not open the lightbox for an attachment that never resolved', async () => {
    fetchUrl.mockResolvedValue(null)
    const { CommentBody } = await import('@/components/flags/CommentBody')
    render(
      <CommentBody body="{attachment:5}" mentions={[]} users={new Map()} />
    )
    await waitFor(() => expect(fetchUrl).toHaveBeenCalledWith(5))
    const img = document.querySelector('img.flag-attach') as HTMLImageElement
    expect(img.getAttribute('src')).toBeNull()
    fireEvent.click(img)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
