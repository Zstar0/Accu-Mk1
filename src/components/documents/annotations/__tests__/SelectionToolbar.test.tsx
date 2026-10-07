import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SelectionToolbar } from '../SelectionToolbar'

const labels = [
  {
    id: 'clarify-this',
    emoji: '❓',
    text: 'Clarify this',
    color: 'yellow',
    tip: null,
  },
  {
    id: 'verify-this',
    emoji: '🔍',
    text: 'Verify this',
    color: 'orange',
    tip: null,
  },
]

describe('SelectionToolbar', () => {
  it('offers comment, suggest, label, and thumbs-up; digit keys pick labels', () => {
    const onLabel = vi.fn()
    const onComment = vi.fn()
    render(
      <SelectionToolbar
        rect={{ top: 100, left: 20, width: 10, height: 10 }}
        labels={labels}
        onComment={onComment}
        onSuggest={vi.fn()}
        onLabel={onLabel}
        onThumbsUp={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(onComment).toHaveBeenCalled()
    fireEvent.keyDown(window, { key: '2' })
    expect(onLabel).toHaveBeenCalledWith(labels[1])
    const bar = screen.getByRole('toolbar')
    expect(bar.style.top).toBe('60px')
  })
})
