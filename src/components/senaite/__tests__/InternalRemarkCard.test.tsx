import { describe, it, expect } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { InternalRemarkCard } from '@/components/senaite/InternalRemarkCard'

describe('InternalRemarkCard', () => {
  it('renders author, date, sanitized body, and the internal-only caption', () => {
    render(
      <InternalRemarkCard
        author="42"
        createdLabel="Jul 2, 26 3:00 PM"
        content={
          '<b>Bold</b> and <a href="https://x.test">a link</a><script>alert(1)</script>'
        }
      />
    )
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('Jul 2, 26 3:00 PM')).toBeInTheDocument()
    expect(screen.getByText('Bold')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'a link' })).toHaveAttribute(
      'href',
      'https://x.test'
    )
    expect(
      screen.getByText(/not shared with the customer/i)
    ).toBeInTheDocument()
  })
})
