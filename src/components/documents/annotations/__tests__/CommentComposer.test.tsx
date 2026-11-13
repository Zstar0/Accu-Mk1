import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CommentComposer } from '../CommentComposer'

const labels = [
  {
    id: 'verify-this',
    emoji: '🔍',
    text: 'Verify this',
    color: 'orange',
    tip: null,
  },
]
const rect = { top: 10, left: 10, width: 50, height: 10 }

describe('CommentComposer', () => {
  it('Ctrl+Enter submits the body and the chosen label', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentComposer
        open
        rect={rect}
        mode="comment"
        quote="q"
        labels={labels}
        initialLabel={labels[0]}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        uploadImage={async () => 1}
      />
    )
    const ta = screen.getByPlaceholderText('Add a comment…')
    await userEvent.type(ta, 'why?')
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true })
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        body: 'why?',
        suggested_text: undefined,
        label: 'verify-this',
      })
    )
  })

  it('pasting an image uploads it and inserts the token at the caret', async () => {
    const uploadImage = vi.fn().mockResolvedValue(42)
    render(
      <CommentComposer
        open
        rect={rect}
        mode="comment"
        quote="q"
        labels={labels}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        uploadImage={uploadImage}
      />
    )
    const ta = screen.getByPlaceholderText(
      'Add a comment…'
    ) as HTMLTextAreaElement
    const file = new File([new Uint8Array([1])], 'shot.png', {
      type: 'image/png',
    })
    fireEvent.paste(ta, { clipboardData: { files: [file] } })
    await waitFor(() => expect(ta.value).toBe('{attachment:42}'))
    expect(uploadImage).toHaveBeenCalledWith(file, 'shot.png')
  })

  it('suggestion mode requires replacement text', async () => {
    const onSubmit = vi.fn()
    render(
      <CommentComposer
        open
        rect={rect}
        mode="suggestion"
        quote="old words"
        labels={labels}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        uploadImage={async () => 1}
      />
    )
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Replace with'))
    await userEvent.type(screen.getByLabelText('Replace with'), 'new words')
    expect(save).toBeEnabled()
  })

  it('refuses a quote over 400 characters with a clear message', () => {
    render(
      <CommentComposer
        open
        rect={rect}
        mode="comment"
        quote={'x'.repeat(401)}
        labels={labels}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        uploadImage={async () => 1}
      />
    )
    expect(
      screen.getByText(/Selection is 401 characters; the limit is 400/)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('Escape cancels', () => {
    const onCancel = vi.fn()
    render(
      <CommentComposer
        open
        rect={rect}
        mode="global"
        quote=""
        labels={labels}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={onCancel}
        uploadImage={async () => 1}
      />
    )
    fireEvent.keyDown(screen.getByPlaceholderText('Add a comment…'), {
      key: 'Escape',
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('a rejected onSubmit keeps the draft and does not throw', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('boom'))
    render(
      <CommentComposer
        open
        rect={rect}
        mode="comment"
        quote="q"
        labels={labels}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        uploadImage={async () => 1}
      />
    )
    const ta = screen.getByPlaceholderText(
      'Add a comment…'
    ) as HTMLTextAreaElement
    await userEvent.type(ta, 'keep me')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    )
    expect(ta.value).toBe('keep me')
  })

  it('pasting an image inserts the token at the caret mid-text', async () => {
    const uploadImage = vi.fn().mockResolvedValue(42)
    render(
      <CommentComposer
        open
        rect={rect}
        mode="comment"
        quote="q"
        labels={labels}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        uploadImage={uploadImage}
      />
    )
    const ta = screen.getByPlaceholderText(
      'Add a comment…'
    ) as HTMLTextAreaElement
    await userEvent.type(ta, 'abcd')
    ta.setSelectionRange(2, 2)
    const file = new File([new Uint8Array([1])], 'shot.png', {
      type: 'image/png',
    })
    fireEvent.paste(ta, { clipboardData: { files: [file] } })
    await waitFor(() => expect(ta.value).toBe('ab{attachment:42}cd'))
  })
})
