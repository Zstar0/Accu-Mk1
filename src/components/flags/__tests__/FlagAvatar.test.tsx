import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FlagAvatar } from '@/components/flags/FlagAvatar'

// The photo is decorative (alt="") — the author's name always shows as text
// beside it — so it's role="presentation"; query it by tag.
const img = () => document.querySelector('img')

describe('FlagAvatar', () => {
  it('renders the Slack photo when avatarUrl is present', () => {
    render(
      <FlagAvatar
        initials="FP"
        color="#123456"
        avatarUrl="https://avatars.slack-edge.com/x_72.png"
      />
    )
    expect(img()).toHaveAttribute('src', 'https://avatars.slack-edge.com/x_72.png')
    // Initials are not shown while the photo renders.
    expect(screen.queryByText('FP')).not.toBeInTheDocument()
  })

  it('falls back to the initials circle when avatarUrl is null', () => {
    render(<FlagAvatar initials="FP" color="#123456" avatarUrl={null} />)
    expect(img()).toBeNull()
    expect(screen.getByText('FP')).toBeInTheDocument()
  })

  it('falls back to initials when the photo fails to load (onError)', () => {
    render(
      <FlagAvatar
        initials="FP"
        color="#123456"
        avatarUrl="https://avatars.slack-edge.com/broken.png"
      />
    )
    fireEvent.error(img() as HTMLImageElement)
    expect(img()).toBeNull()
    expect(screen.getByText('FP')).toBeInTheDocument()
  })
})
